// @rewind/feedback — Feedback & Recognition (spec: 02-feedback-recognition.md).
//
// Kudos, feedback (requested / offered / continuous / after an event),
// feedback requests, personal history, explicit next steps, private 1:1 notes
// and neutral in-app notifications.
//
// Privacy rules enforced here (spec §3–§4):
//   - every read checks the item's own audience; admins get no bypass;
//   - feedback audiences are frozen at send time (membership changes, from the
//     IdP or by hand, never widen access to what was already sent);
//   - private content never reaches dashboards, events, exports of others or
//     notification text;
//   - no scores, rankings or counts per person.
//
// People/teams come from core, groups/memberships/roles/links/events/audit
// from the foundation's helpers. The module owns only its fb*: keys.

import { defineModule, fail, json, newId, now, str } from '@rewind/core';
import { recordAudit, recordEvent, createLink, deleteLink, K as FK } from '@rewind/foundation/server/events';
import { activeMemberships, hasPermission, loadPermissions, registerPermissions } from '@rewind/foundation/server/rbac';
import {
  COMMITMENT_STATUS, DEFAULT_CATEGORIES, FEEDBACK_AUDIENCES, FEEDBACK_KINDS, LINK_TARGETS, PERMISSIONS, REACTIONS,
  RECOGNITION_AUDIENCES, REQUEST_STATUS,
  assertValidCommitment, assertValidFeedback, assertValidRecognition, assertValidRequest, cleanAudience,
  cleanCategories, cleanCommitment, cleanFeedback, cleanRecognition, cleanRequest,
} from './model.js';

const K = {
  settings: (o) => `fbset:${o}`,
  recognition: (o, id) => `fbrec:${o}:${id}`,
  recognitions: (o) => `fbrec:${o}:`,
  reaction: (o, recId, userId, emoji) => `fbreact:${o}:${recId}:${userId}:${encodeURIComponent(emoji)}`,
  reactionsOf: (o, recId) => `fbreact:${o}:${recId}:`,
  feedback: (o, id) => `fbfb:${o}:${id}`,
  feedbacks: (o) => `fbfb:${o}:`,
  request: (o, id) => `fbreq:${o}:${id}`,
  requests: (o) => `fbreq:${o}:`,
  commitment: (o, id) => `fbcmt:${o}:${id}`,
  commitments: (o) => `fbcmt:${o}:`,
  // notes live under their author: no route lists another person's notes
  note: (o, userId, id) => `fbnote:${o}:${userId}:${id}`,
  notesOf: (o, userId) => `fbnote:${o}:${userId}:`,
  notification: (o, userId, id) => `fbntf:${o}:${userId}:${id}`,
  notificationsOf: (o, userId) => `fbntf:${o}:${userId}:`,
};

const SRC = { recognition: 'feedback.recognition', feedback: 'feedback.feedback' };
const byNewest = (a, b) => b.createdAt.localeCompare(a.createdAt);
const isActiveAt = (m, at) => (!m.validFrom || m.validFrom <= at) && (!m.validTo || m.validTo >= at);

export default defineModule({
  id: 'feedback',
  name: 'Feedback & Recognition',
  description: 'Kudos, feedback and feedback requests with explicit audiences, personal history and next steps. No scores or rankings.',
  defaultEnabled: true,
  keyPrefixes: ['fbset:', 'fbrec:', 'fbfb:', 'fbreq:', 'fbcmt:', 'fbnote:'],
  shards: { fbset: 'org', fbrec: 'org', fbreact: 'org', fbfb: 'org', fbreq: 'org', fbcmt: 'org', fbnote: 'org', fbntf: 'org' },
  register(core) {
    const { db, isAdmin, getTeam, listUsers, listTeams } = core;
    registerPermissions(PERMISSIONS);

    // ------------------------------------------------------------ settings
    async function settings(orgId) {
      const s = await db.get(K.settings(orgId));
      return { categories: s?.categories?.length ? s.categories : DEFAULT_CATEGORIES, allowOrgAudience: s?.allowOrgAudience !== false };
    }

    // ------------------------------------------------------------ people & scopes
    async function people(orgId) {
      return listUsers(orgId);
    }

    // members of a team/group *now* (core teams + foundation memberships)
    async function scopeMembers(orgId, type, id) {
      const at = now();
      const [users, memberships] = await Promise.all([listUsers(orgId), db.list(FK.memberships(orgId))]);
      const set = new Set(memberships.filter((m) => m.scopeType === type && m.scopeId === id && isActiveAt(m, at)).map((m) => m.userId));
      if (type === 'team') for (const u of users) if ((u.teamIds || []).includes(id)) set.add(u.id);
      return set;
    }

    async function userInScope(c, type, id) {
      if (type === 'team' && (c.user.teamIds || []).includes(id)) return true;
      const mine = await activeMemberships(db, c.org.id, c.user.id);
      return mine.some((m) => m.scopeType === type && m.scopeId === id);
    }

    async function checkAudience(c, audience, { allowOrg }) {
      if (audience.type === 'org' && !allowOrg) fail(400, "Your company doesn't allow company-wide recognition");
      if (audience.type === 'team' && !(await getTeam(c.org.id, audience.id))) fail(400, 'Team not found');
      if (audience.type === 'group' && !(await db.get(FK.group(c.org.id, audience.id)))) fail(400, 'Group not found');
      // you can only address an audience you are part of
      if ((audience.type === 'team' || audience.type === 'group') && !(await userInScope(c, audience.type, audience.id))) {
        fail(403, `You aren't a member of this ${audience.type}`);
      }
    }

    async function checkRecipients(c, recipientIds) {
      const users = await people(c.org.id);
      for (const id of recipientIds) if (!users.some((u) => u.id === id)) fail(400, 'A recipient is not a member of the company');
      if (recipientIds.includes(c.user.id)) fail(400, "You can't address yourself");
    }

    // ------------------------------------------------------------ visibility (no admin bypass)
    async function canSeeRecognition(c, r) {
      if (r.authorId === c.user.id || r.recipientIds.includes(c.user.id)) return true;
      if (r.audience.type === 'org') return true;
      if (r.audience.type === 'team' || r.audience.type === 'group') return userInScope(c, r.audience.type, r.audience.id);
      return false;
    }

    // frozen list: participants + audience members at send time
    const canSeeFeedback = (c, f) => f.authorId === c.user.id || f.recipientIds.includes(c.user.id) || (f.audienceUserIds || []).includes(c.user.id);
    const canSeeRequest = (c, r) => r.authorId === c.user.id || r.recipientIds.includes(c.user.id);

    // ------------------------------------------------------------ audit, events, notifications
    const audit = (c, action, extra = {}) => recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action, ...extra });

    async function notify(c, userIds, { type, text, href }) {
      for (const userId of new Set(userIds)) {
        if (userId === c.user.id) continue;
        const prefs = await db.list(FK.notifPrefsFor(c.org.id, userId));
        const off = prefs.some((p) => p.module === 'feedback' && p.channel === 'in_app' && !p.enabled && [type, '*'].includes(p.eventType));
        if (off) continue;
        const n = { id: newId(), userId, type, text, href, read: false, createdAt: now() };
        await db.put(K.notification(c.org.id, userId, n.id), n);
      }
    }

    async function saveLinks(c, sourceType, sourceId, links) {
      for (const l of links) {
        await createLink(db, { orgId: c.org.id, sourceType, sourceId, targetType: l.targetType, targetId: l.targetId, relationshipType: 'recognized_in', createdBy: c.user.id });
      }
    }

    async function linksOf(orgId, sourceType, sourceId) {
      const out = [];
      for (const ref of await db.list(FK.linksBySource(orgId, sourceType, sourceId))) {
        const l = await db.get(FK.link(orgId, ref.id));
        if (l) out.push({ id: l.id, targetType: l.targetType, targetId: l.targetId });
      }
      return out;
    }

    async function dropLinks(orgId, sourceType, sourceId) {
      for (const ref of await db.list(FK.linksBySource(orgId, sourceType, sourceId))) await deleteLink(db, { orgId, id: ref.id });
    }

    async function withReactions(c, r) {
      const all = await db.list(K.reactionsOf(c.org.id, r.id));
      const counts = {};
      for (const x of all) counts[x.emoji] = (counts[x.emoji] || 0) + 1;
      return { ...r, reactions: counts, myReactions: all.filter((x) => x.userId === c.user.id).map((x) => x.emoji), links: await linksOf(c.org.id, SRC.recognition, r.id) };
    }

    // ------------------------------------------------------------ catalog, people, preview
    core.route('GET', '/api/feedback/catalog', async (c) => {
      const s = await settings(c.org.id);
      const perms = await loadPermissions(db, c.org.id, c.user);
      return json({
        ...s,
        recognitionAudiences: RECOGNITION_AUDIENCES.filter((a) => a !== 'org' || s.allowOrgAudience),
        feedbackAudiences: FEEDBACK_AUDIENCES, kinds: FEEDBACK_KINDS, requestStatus: REQUEST_STATUS,
        commitmentStatus: COMMITMENT_STATUS, reactions: REACTIONS, linkTargets: LINK_TARGETS,
        canManage: isAdmin(c) || hasPermission(perms, 'feedback:admin'),
      });
    });

    // Search people by name/e-mail, and teams/groups (with member ids) for
    // picking recipients. E-mails are matched but only shown for exact matches.
    core.route('GET', '/api/feedback/people', async (c) => {
      const q = (c.url.searchParams.get('q') || '').trim().toLowerCase();
      const [users, teams, groups, memberships] = await Promise.all([people(c.org.id), listTeams(c.org.id), db.list(FK.groups(c.org.id)), db.list(FK.memberships(c.org.id))]);
      const at = now();
      const match = (s) => !q || (s || '').toLowerCase().includes(q);
      const membersOf = (type, id) => {
        const set = new Set(memberships.filter((m) => m.scopeType === type && m.scopeId === id && isActiveAt(m, at)).map((m) => m.userId));
        if (type === 'team') for (const u of users) if ((u.teamIds || []).includes(id)) set.add(u.id);
        return [...set];
      };
      return json({
        people: users.filter((u) => match(u.name) || match(u.email)).map(({ id, name, avatar, teamIds }) => ({ id, name, avatar, teamIds })),
        teams: teams.filter((t) => match(t.name)).map((t) => ({ id: t.id, name: t.name, memberIds: membersOf('team', t.id) })),
        groups: groups.filter((g) => match(g.name)).map((g) => ({ id: g.id, name: g.name, memberIds: membersOf('group', g.id) })),
      });
    });

    // "Who will see this?" — shown before sending (spec §4.1).
    core.route('POST', '/api/feedback/audience-preview', async (c) => {
      const kind = c.body?.kind === 'feedback' ? 'feedback' : 'recognition';
      const s = await settings(c.org.id);
      const audience = cleanAudience(c.body?.audience, kind === 'feedback' ? FEEDBACK_AUDIENCES : RECOGNITION_AUDIENCES);
      const recipientIds = Array.isArray(c.body?.recipientIds) ? c.body.recipientIds.map(String) : [];
      const users = await people(c.org.id);
      const name = (id) => users.find((u) => u.id === id)?.name || '—';
      const participants = [c.user.id, ...recipientIds].map(name);
      if (audience.type === 'org') {
        if (!s.allowOrgAudience) fail(400, "Your company doesn't allow company-wide recognition");
        return json({ audience, summary: 'Everyone in the company', count: users.length, participants });
      }
      if (audience.type === 'private') return json({ audience, summary: 'Only you and the recipients', count: new Set([c.user.id, ...recipientIds]).size, participants });
      const members = await scopeMembers(c.org.id, audience.type, audience.id);
      const scopeName = audience.type === 'team' ? (await getTeam(c.org.id, audience.id))?.name : (await db.get(FK.group(c.org.id, audience.id)))?.name;
      const rule = kind === 'feedback' ? 'people in it today (people who join later will not see it)' : 'current and future members';
      return json({ audience, summary: `You, the recipients and the ${audience.type} "${scopeName || '—'}" — ${rule}`, count: new Set([c.user.id, ...recipientIds, ...members]).size, participants });
    });

    // ------------------------------------------------------------ settings (admins / feedback:admin)
    core.route('PUT', '/api/feedback/settings', async (c) => {
      const perms = await loadPermissions(db, c.org.id, c.user);
      if (!isAdmin(c) && !hasPermission(perms, 'feedback:admin')) fail(403, 'Only feedback admins can change the policy');
      const before = await db.get(K.settings(c.org.id));
      const categories = cleanCategories(c.body?.categories);
      if (!categories.length) fail(400, 'Keep at least one category');
      const next = { categories, allowOrgAudience: c.body?.allowOrgAudience !== false, updatedAt: now(), updatedBy: c.user.id };
      await db.put(K.settings(c.org.id), next);
      await audit(c, 'feedback.settings.update', { before, after: next });
      return json({ settings: next });
    });

    // ------------------------------------------------------------ recognitions
    core.route('GET', '/api/feedback/recognitions', async (c) => {
      const q = c.url.searchParams;
      const f = { category: q.get('category'), person: q.get('person'), audience: q.get('audience'), mine: q.get('mine') === '1' };
      const out = [];
      for (const r of (await db.list(K.recognitions(c.org.id))).sort(byNewest)) {
        if (!(await canSeeRecognition(c, r))) continue;
        if (f.category && r.category !== f.category) continue;
        if (f.audience && r.audience.type !== f.audience) continue;
        if (f.person && r.authorId !== f.person && !r.recipientIds.includes(f.person)) continue;
        if (f.mine && r.authorId !== c.user.id && !r.recipientIds.includes(c.user.id)) continue;
        out.push(await withReactions(c, r));
        if (out.length >= 200) break;
      }
      return json({ recognitions: out });
    });

    core.route('POST', '/api/feedback/recognitions', async (c) => {
      const s = await settings(c.org.id);
      const data = cleanRecognition(c.body, s.categories);
      const err = assertValidRecognition(data);
      if (err) fail(400, err);
      await checkRecipients(c, data.recipientIds);
      await checkAudience(c, data.audience, { allowOrg: s.allowOrgAudience });
      const { links, ...rest } = data;
      const r = { id: newId(), orgId: c.org.id, authorId: c.user.id, ...rest, audienceHistory: [], createdAt: now() };
      await db.put(K.recognition(c.org.id, r.id), r);
      await saveLinks(c, SRC.recognition, r.id, links);
      // only recognitions whose audience isn't private reach the timeline
      if (r.audience.type !== 'private') {
        await recordEvent(db, {
          orgId: c.org.id, actorId: c.user.id, teamId: r.audience.type === 'team' ? r.audience.id : null,
          entityType: SRC.recognition, entityId: r.id, eventType: 'feedback.recognition.created', source: 'manual',
          metadata: { audience: r.audience, category: r.category, recipientIds: r.recipientIds },
        });
      }
      await notify(c, r.recipientIds, { type: 'feedback.recognition', text: 'Someone recognized your work', href: `#/kudos/${r.id}` });
      return json({ recognition: await withReactions(c, r) }, 201);
    });

    async function getRecognition(c, id) {
      const r = await db.get(K.recognition(c.org.id, id));
      if (!r || !(await canSeeRecognition(c, r))) fail(404, 'Recognition not found');
      return r;
    }

    core.route('GET', '/api/feedback/recognitions/:id', async (c) => json({ recognition: await withReactions(c, await getRecognition(c, c.params.id)) }));

    // Changing the audience is logged and communicated to the participants (spec §4.5).
    core.route('PATCH', '/api/feedback/recognitions/:id/audience', async (c) => {
      const r = await getRecognition(c, c.params.id);
      if (r.authorId !== c.user.id) fail(403, 'Only the author can change who sees it');
      const s = await settings(c.org.id);
      const audience = cleanAudience(c.body?.audience, RECOGNITION_AUDIENCES);
      if ((audience.type === 'team' || audience.type === 'group') && !audience.id) fail(400, `Choose the ${audience.type}`);
      await checkAudience(c, audience, { allowOrg: s.allowOrgAudience });
      const before = r.audience;
      r.audienceHistory = [...(r.audienceHistory || []), { at: now(), by: c.user.id, from: before, to: audience }];
      r.audience = audience;
      await db.put(K.recognition(c.org.id, r.id), r);
      await audit(c, 'feedback.recognition.audience_changed', { target: r.id, before: { audience: before }, after: { audience } });
      await notify(c, r.recipientIds, { type: 'feedback.audience', text: 'The audience of a recognition you are part of changed', href: `#/kudos/${r.id}` });
      return json({ recognition: await withReactions(c, r) });
    });

    core.route('DELETE', '/api/feedback/recognitions/:id', async (c) => {
      const r = await getRecognition(c, c.params.id);
      if (r.authorId !== c.user.id) fail(403, 'Only the author can delete it');
      for (const x of await db.list(K.reactionsOf(c.org.id, r.id))) await db.delete(K.reaction(c.org.id, r.id, x.userId, x.emoji));
      await dropLinks(c.org.id, SRC.recognition, r.id);
      await db.delete(K.recognition(c.org.id, r.id));
      await audit(c, 'feedback.recognition.delete', { target: r.id, metadata: { audience: r.audience.type } });
      return json({ ok: true });
    });

    // reactions: a toggle per person and emoji; never a score
    core.route('POST', '/api/feedback/recognitions/:id/reactions', async (c) => {
      const r = await getRecognition(c, c.params.id);
      const emoji = REACTIONS.includes(c.body?.emoji) ? c.body.emoji : null;
      if (!emoji) fail(400, 'Unknown reaction');
      const key = K.reaction(c.org.id, r.id, c.user.id, emoji);
      if (await db.get(key)) await db.delete(key);
      else await db.put(key, { userId: c.user.id, emoji, at: now() });
      return json({ recognition: await withReactions(c, r) });
    });

    // ------------------------------------------------------------ feedback
    async function createFeedback(c, data, { requestId = null } = {}) {
      await checkRecipients(c, data.recipientIds);
      let audienceUserIds = [];
      if (data.audience.type !== 'private') {
        await checkAudience(c, data.audience, { allowOrg: false });
        audienceUserIds = [...(await scopeMembers(c.org.id, data.audience.type, data.audience.id))];
      }
      const { links, ...rest } = data;
      const f = {
        id: newId(), orgId: c.org.id, authorId: c.user.id, ...rest, requestId,
        audienceUserIds, // frozen: later membership changes don't widen it
        readBy: [], discussedBy: [], revisions: [], createdAt: now(), updatedAt: now(),
      };
      await db.put(K.feedback(c.org.id, f.id), f);
      await saveLinks(c, SRC.feedback, f.id, links);
      // neutral text: the channel never carries the content (spec §3)
      await notify(c, f.recipientIds, { type: 'feedback.feedback', text: 'You received new feedback', href: `#/feedback/${f.id}` });
      return f;
    }

    const feedbackView = async (c, f) => ({ ...f, audienceUserIds: undefined, audienceSize: f.audienceUserIds?.length || 0, links: await linksOf(c.org.id, SRC.feedback, f.id) });

    core.route('POST', '/api/feedback/feedback', async (c) => {
      const data = cleanFeedback(c.body);
      if (data.kind === 'requested') data.kind = 'offered'; // "requested" only through a request
      const err = assertValidFeedback(data);
      if (err) fail(400, err);
      const f = await createFeedback(c, data);
      return json({ feedback: await feedbackView(c, f) }, 201);
    });

    async function getFeedback(c, id) {
      const f = await db.get(K.feedback(c.org.id, id));
      if (!f || !canSeeFeedback(c, f)) fail(404, 'Feedback not found');
      return f;
    }

    core.route('GET', '/api/feedback/feedback/:id', async (c) => {
      const f = await getFeedback(c, c.params.id);
      if (f.recipientIds.includes(c.user.id) && !f.readBy.includes(c.user.id)) {
        f.readBy = [...f.readBy, c.user.id];
        await db.patch(K.feedback(c.org.id, f.id), { readBy: f.readBy });
      }
      const commitments = (await db.list(K.commitments(c.org.id))).filter((x) => x.feedbackId === f.id);
      return json({ feedback: await feedbackView(c, f), commitments });
    });

    // Editing after a recipient has read it is not allowed; before that, every
    // previous version is kept (decision for spec §10).
    core.route('PATCH', '/api/feedback/feedback/:id', async (c) => {
      const f = await getFeedback(c, c.params.id);
      if (f.authorId !== c.user.id) fail(403, 'Only the author can edit it');
      if (f.readBy.length) fail(409, 'Already read: send a new feedback instead of editing');
      const fields = ['situation', 'behavior', 'impact', 'suggestion'];
      const prev = Object.fromEntries(fields.map((k) => [k, f[k]]));
      const next = { ...prev };
      for (const k of fields) if (c.body?.[k] !== undefined) next[k] = str(c.body[k], 2000);
      if (!Object.values(next).some(Boolean)) fail(400, 'Write the feedback');
      f.revisions = [...f.revisions, { at: now(), ...prev }];
      Object.assign(f, next, { updatedAt: now() });
      await db.put(K.feedback(c.org.id, f.id), f);
      return json({ feedback: await feedbackView(c, f) });
    });

    core.route('DELETE', '/api/feedback/feedback/:id', async (c) => {
      const f = await getFeedback(c, c.params.id);
      if (f.authorId !== c.user.id) fail(403, 'Only the author can delete it');
      await dropLinks(c.org.id, SRC.feedback, f.id);
      await db.delete(K.feedback(c.org.id, f.id));
      await audit(c, 'feedback.feedback.delete', { target: f.id, metadata: { kind: f.kind } });
      return json({ ok: true });
    });

    core.route('POST', '/api/feedback/feedback/:id/discussed', async (c) => {
      const f = await getFeedback(c, c.params.id);
      if (f.authorId !== c.user.id && !f.recipientIds.includes(c.user.id)) fail(403, 'Only participants can mark it');
      const on = c.body?.discussed !== false;
      f.discussedBy = on ? [...new Set([...f.discussedBy, c.user.id])] : f.discussedBy.filter((x) => x !== c.user.id);
      await db.patch(K.feedback(c.org.id, f.id), { discussedBy: f.discussedBy });
      return json({ feedback: await feedbackView(c, f) });
    });

    // ------------------------------------------------------------ requests
    core.route('GET', '/api/feedback/requests', async (c) => {
      const all = (await db.list(K.requests(c.org.id))).filter((r) => canSeeRequest(c, r)).sort(byNewest);
      return json({
        sent: all.filter((r) => r.authorId === c.user.id),
        received: all.filter((r) => r.recipientIds.includes(c.user.id)).map((r) => ({ ...r, answeredByMe: r.answeredBy.includes(c.user.id) })),
      });
    });

    core.route('POST', '/api/feedback/requests', async (c) => {
      const data = cleanRequest(c.body);
      const err = assertValidRequest(data);
      if (err) fail(400, err);
      await checkRecipients(c, data.recipientIds);
      const r = { id: newId(), orgId: c.org.id, authorId: c.user.id, ...data, status: 'open', answeredBy: [], responseIds: [], createdAt: now(), updatedAt: now() };
      await db.put(K.request(c.org.id, r.id), r);
      await notify(c, r.recipientIds, { type: 'feedback.request', text: 'Someone asked for your feedback', href: `#/feedback/requests/${r.id}` });
      return json({ request: r }, 201);
    });

    async function getRequest(c, id) {
      const r = await db.get(K.request(c.org.id, id));
      if (!r || !canSeeRequest(c, r)) fail(404, 'Request not found');
      return r;
    }

    // the requester sees every answer; a responder sees only their own
    core.route('GET', '/api/feedback/requests/:id', async (c) => {
      const r = await getRequest(c, c.params.id);
      const responses = [];
      for (const id of r.responseIds) {
        const f = await db.get(K.feedback(c.org.id, id));
        if (f && canSeeFeedback(c, f)) responses.push(await feedbackView(c, f));
      }
      return json({ request: r, responses });
    });

    // Multiple answers allowed; each answer is a "requested" Feedback addressed
    // to the requester, private by default.
    core.route('POST', '/api/feedback/requests/:id/responses', async (c) => {
      const r = await getRequest(c, c.params.id);
      if (!r.recipientIds.includes(c.user.id)) fail(403, "You weren't asked");
      if (!['open', 'answered'].includes(r.status)) fail(409, 'This request is closed');
      const data = cleanFeedback({ ...c.body, kind: 'requested', recipientIds: [r.authorId] });
      const err = assertValidFeedback(data);
      if (err) fail(400, err);
      const f = await createFeedback(c, data, { requestId: r.id });
      r.responseIds = [...r.responseIds, f.id];
      r.answeredBy = [...new Set([...r.answeredBy, c.user.id])];
      r.status = 'answered';
      r.updatedAt = now();
      await db.put(K.request(c.org.id, r.id), r);
      return json({ feedback: await feedbackView(c, f), request: r }, 201);
    });

    core.route('PATCH', '/api/feedback/requests/:id', async (c) => {
      const r = await getRequest(c, c.params.id);
      if (r.authorId !== c.user.id) fail(403, 'Only who asked can change it');
      const status = c.body?.status;
      if (!['closed', 'cancelled'].includes(status)) fail(400, 'Close or cancel the request');
      if (['closed', 'cancelled'].includes(r.status)) fail(409, 'This request is already closed');
      r.status = status;
      r.updatedAt = now();
      await db.put(K.request(c.org.id, r.id), r);
      return json({ request: r });
    });

    // ------------------------------------------------------------ commitments (explicit next steps)
    async function participantsOfFeedback(c, feedbackId) {
      if (!feedbackId) return null;
      const f = await getFeedback(c, feedbackId);
      if (f.authorId !== c.user.id && !f.recipientIds.includes(c.user.id)) fail(403, 'Only participants can add next steps');
      return f;
    }
    const canSeeCommitment = (c, x) => x.createdBy === c.user.id || x.ownerId === c.user.id || (x.participantIds || []).includes(c.user.id);

    core.route('GET', '/api/feedback/commitments', async (c) =>
      json({ commitments: (await db.list(K.commitments(c.org.id))).filter((x) => canSeeCommitment(c, x)).sort(byNewest) }),
    );

    core.route('POST', '/api/feedback/commitments', async (c) => {
      const data = cleanCommitment(c.body);
      const err = assertValidCommitment(data);
      if (err) fail(400, err);
      const f = await participantsOfFeedback(c, str(c.body?.feedbackId, 60) || null);
      const participantIds = f ? [f.authorId, ...f.recipientIds] : [c.user.id];
      if (!participantIds.includes(data.ownerId) && data.ownerId !== c.user.id) fail(400, 'The owner must be one of the participants');
      const x = { id: newId(), orgId: c.org.id, ...data, feedbackId: f?.id || null, participantIds, createdBy: c.user.id, createdAt: now(), updatedAt: now() };
      await db.put(K.commitment(c.org.id, x.id), x);
      await notify(c, [x.ownerId], { type: 'feedback.commitment', text: 'A next step was assigned to you', href: '#/feedback/history' });
      return json({ commitment: x }, 201);
    });

    core.route('PATCH', '/api/feedback/commitments/:id', async (c) => {
      const x = await db.get(K.commitment(c.org.id, c.params.id));
      if (!x || !canSeeCommitment(c, x)) fail(404, 'Next step not found');
      const data = cleanCommitment(c.body || {}, x);
      const err = assertValidCommitment(data);
      if (err) fail(400, err);
      Object.assign(x, data, { updatedAt: now() });
      await db.put(K.commitment(c.org.id, x.id), x);
      return json({ commitment: x });
    });

    // ------------------------------------------------------------ private notes (author only)
    core.route('GET', '/api/feedback/notes', async (c) => {
      const about = c.url.searchParams.get('about');
      const notes = (await db.list(K.notesOf(c.org.id, c.user.id))).filter((n) => !about || n.aboutUserId === about).sort(byNewest);
      return json({ notes });
    });

    core.route('POST', '/api/feedback/notes', async (c) => {
      const text = str(c.body?.text, 4000);
      if (!text) fail(400, 'Write the note');
      const n = { id: newId(), aboutUserId: str(c.body?.aboutUserId, 60) || null, text, createdAt: now(), updatedAt: now() };
      await db.put(K.note(c.org.id, c.user.id, n.id), n);
      return json({ note: n }, 201);
    });

    core.route('DELETE', '/api/feedback/notes/:id', async (c) => {
      const key = K.note(c.org.id, c.user.id, c.params.id);
      if (!(await db.get(key))) fail(404, 'Note not found');
      await db.delete(key);
      return json({ ok: true });
    });

    // ------------------------------------------------------------ personal history & export
    // Only items the person takes part in (author or recipient).
    async function myItems(c) {
      const mine = (x) => x.authorId === c.user.id || x.recipientIds.includes(c.user.id);
      const [recs, fbs] = await Promise.all([db.list(K.recognitions(c.org.id)), db.list(K.feedbacks(c.org.id))]);
      return { recognitions: recs.filter(mine).sort(byNewest), feedback: fbs.filter(mine).sort(byNewest) };
    }

    core.route('GET', '/api/feedback/history', async (c) => {
      const q = c.url.searchParams;
      const from = q.get('from') || '';
      const to = q.get('to') || '';
      const text = (q.get('q') || '').toLowerCase();
      const category = q.get('category');
      const kind = q.get('kind');
      const inRange = (x) => (!from || x.createdAt.slice(0, 10) >= from) && (!to || x.createdAt.slice(0, 10) <= to);
      const has = (x, fields) => !text || fields.some((k) => (x[k] || '').toLowerCase().includes(text));
      const { recognitions, feedback } = await myItems(c);
      return json({
        recognitions: await Promise.all(recognitions.filter((r) => inRange(r) && (!category || r.category === category) && has(r, ['context', 'contribution', 'impact'])).map((r) => withReactions(c, r))),
        feedback: await Promise.all(feedback.filter((f) => inRange(f) && (!kind || f.kind === kind) && has(f, ['situation', 'behavior', 'impact', 'suggestion'])).map((f) => feedbackView(c, f))),
      });
    });

    // a person exports their own items only — never someone else's
    core.route('GET', '/api/feedback/export', async (c) => {
      const items = await myItems(c);
      const notes = await db.list(K.notesOf(c.org.id, c.user.id));
      await audit(c, 'feedback.export', { metadata: { recognitions: items.recognitions.length, feedback: items.feedback.length } });
      return json({ exportedAt: now(), ...items, feedback: items.feedback.map(({ audienceUserIds, ...f }) => f), notes });
    });

    // ------------------------------------------------------------ notifications (in-app, neutral text)
    core.route('GET', '/api/feedback/notifications', async (c) => {
      const list = (await db.list(K.notificationsOf(c.org.id, c.user.id))).sort(byNewest).slice(0, 50);
      // open requests waiting for my answer, with reminders on
      const today = now().slice(0, 10);
      const pending = (await db.list(K.requests(c.org.id))).filter((r) => r.remind && r.status !== 'closed' && r.status !== 'cancelled' && r.recipientIds.includes(c.user.id) && !r.answeredBy.includes(c.user.id));
      const reminders = pending.map((r) => ({ id: `req-${r.id}`, type: 'feedback.reminder', text: r.dueDate && r.dueDate < today ? 'A feedback request to you is past due' : 'A feedback request is waiting for you', href: `#/feedback/requests/${r.id}`, dueDate: r.dueDate }));
      return json({ notifications: list, reminders });
    });

    core.route('POST', '/api/feedback/notifications/read', async (c) => {
      for (const n of await db.list(K.notificationsOf(c.org.id, c.user.id))) if (!n.read) await db.patch(K.notification(c.org.id, c.user.id, n.id), { read: true });
      return json({ ok: true });
    });

    // ------------------------------------------------------------ dashboard (no content, no per-person counts of others)
    return {
      dashboard: async (c) => {
        const [notifs, requests] = await Promise.all([db.list(K.notificationsOf(c.org.id, c.user.id)), db.list(K.requests(c.org.id))]);
        return {
          unread: notifs.filter((n) => !n.read).length,
          pendingRequests: requests.filter((r) => ['open', 'answered'].includes(r.status) && r.recipientIds.includes(c.user.id) && !r.answeredBy.includes(c.user.id)).length,
        };
      },
      adminDashboard: async (c) => ({ onboarding: { feedbackFirstKudos: (await db.list(K.recognitions(c.org.id))).length > 0 } }),
      // recognitions addressed to a team follow the kept team; frozen feedback audiences don't change
      onTeamMerge: async (orgId, fromId, intoId) => {
        for (const r of await db.list(K.recognitions(orgId))) {
          if (r.audience.type === 'team' && r.audience.id === fromId) await db.patch(K.recognition(orgId, r.id), { audience: { type: 'team', id: intoId } });
        }
      },
    };
  },
});
