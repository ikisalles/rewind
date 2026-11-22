// @rewind/issues — the backlog of each team board.
//
// An issue only exists as part of a board: its key lives under the board
// (iss:{boardId}:{id}) and it goes away with the board. Each board chooses its
// source in the board settings: issues created here by hand, or issues read
// from Jira filtered by a Jira Team (synced on demand, read-only copies).
//
// The module owns only its own keys (iss*:). Boards are read through retro's
// published helpers (@rewind/retro/server/boards), people through core
// services. Its features are shown only inside the board (web slots).

import { defineModule, fail, json, newId, now } from '@rewind/core';
import { loadBoard, boardSprints, canManageBoard, onBoardDelete, onRetroCreate } from '@rewind/retro/server/boards';
import { ISSUE_TYPES, PRIORITIES, SOURCES, SPRINT_STATUS, STATUSES, assertValidIssue, assertValidSettings, assertValidSprint, cleanIssue, cleanSettings, cleanSprint, fromJira, jqlFor } from './model.js';

const K = {
  issue: (boardId, id) => `iss:${boardId}:${id}`,
  issues: (boardId) => `iss:${boardId}:`,
  settings: (orgId, boardId) => `isscfg:${orgId}:${boardId}`,
  sprint: (boardId, id) => `isssp:${boardId}:${id}`,
  sprints: (boardId) => `isssp:${boardId}:`,
};
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
// default is off: on only when the company turned it on
const enabledFor = (org) => org?.modules?.issues === true;
const MAX_JIRA = 500;

// cleanup when retro deletes a board (registered once per process)
onBoardDelete(async (db, orgId, board) => {
  for (const i of await db.list(K.issues(board.id))) await db.delete(K.issue(board.id, i.id));
  for (const s of await db.list(K.sprints(board.id))) await db.delete(K.sprint(board.id, s.id));
  await db.delete(K.settings(orgId, board.id));
});

// With the module on, a board's retro is created when a delivery sprint is
// completed (and only once per sprint): the retro looks back at that sprint.
onRetroCreate({
  before: async (db, c, board, body) => {
    if (!enabledFor(c.org)) return;
    const id = typeof body.deliverySprintId === 'string' ? body.deliverySprintId : '';
    const sprint = id && (await db.get(K.sprint(board.id, id)));
    if (!sprint) fail(409, 'Retros start when a sprint is completed. Complete the sprint in the Sprints tab first.');
    if (sprint.status !== 'completed') fail(409, 'Complete the sprint before starting its retro');
    if (sprint.retroSprintId) fail(409, 'This sprint already has a retro');
  },
  after: async (db, c, board, retro, body) => {
    if (!enabledFor(c.org) || !body.deliverySprintId) return;
    await db.patch(K.sprint(board.id, body.deliverySprintId), { retroSprintId: retro.id });
  },
});

export default defineModule({
  id: 'issues',
  name: 'Issues',
  description: "Each team board's backlog: issues created by hand or read from Jira (filtered by Jira Team). Shown inside the board.",
  defaultEnabled: false,
  keyPrefixes: ['iss:', 'isscfg:', 'isssp:'],
  // a board's issues in the board's object (next to its sprints)
  shards: { iss: 'board', isssp: 'board', isscfg: 'org' },
  register(core) {
    const { db, route, teamMembers, integrationFor } = core;

    const stored = (c, boardId) => db.get(K.settings(c.org.id, boardId));
    const settingsOf = async (c, boardId) => {
      const s = (await stored(c, boardId)) || {};
      return cleanSettings(s, s);
    };

    async function context(c) {
      const board = await loadBoard(db, c, c.params.boardId);
      const members = (await teamMembers(c.org.id, board.teamId)) || [];
      return { board, members };
    }

    const order = (a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.createdAt.localeCompare(b.createdAt);

    async function checkRefs(c, board, members, i) {
      const ids = new Set(members.map((m) => m.id));
      if (i.assigneeId && !ids.has(i.assigneeId)) fail(400, "The assignee isn't in the board's team");
      if (i.reporterId && !ids.has(i.reporterId)) fail(400, "The reporter isn't in the board's team");
      if (i.sprintId) await openSprint(board, i.sprintId);
      if (i.parentId) {
        const parent = await db.get(K.issue(board.id, i.parentId));
        if (!parent) fail(400, 'Parent issue not found in this board');
        if (parent.issueType !== 'epic' && i.issueType !== 'subtask') fail(400, 'Only sub-tasks can have a non-epic parent');
      }
    }

    async function openSprint(board, id) {
      const sprint = await db.get(K.sprint(board.id, id));
      if (!sprint) fail(400, "That sprint isn't in this board");
      if (sprint.status === 'completed') fail(400, 'That sprint is already completed');
      return sprint;
    }
    const sprintOrder = (a, b) => SPRINT_STATUS.indexOf(b.status) - SPRINT_STATUS.indexOf(a.status) || (a.createdAt || '').localeCompare(b.createdAt || '');

    // ------------------------------------------------------------ backlog
    route('GET', '/api/issues/boards/:boardId', async (c) => {
      const { board, members } = await context(c);
      const settings = await settingsOf(c, board.id);
      const meta = (await stored(c, board.id)) || {};
      const issues = (await db.list(K.issues(board.id))).sort(order);
      return json({
        settings,
        sync: { lastSyncAt: meta.lastSyncAt || null, lastError: meta.lastError || null, count: meta.lastCount ?? null },
        issues,
        // delivery sprints (this module) and the board's retros (retro, read-only here)
        sprints: (await db.list(K.sprints(board.id))).sort(sprintOrder),
        retros: await boardSprints(db, board.id),
        members: members.map((m) => ({ id: m.id, name: m.name })),
        canManage: canManageBoard(c, board),
        catalog: { types: ISSUE_TYPES, statuses: STATUSES, priorities: PRIORITIES, sources: SOURCES, sprintStatus: SPRINT_STATUS },
      });
    });

    route('PATCH', '/api/issues/boards/:boardId/settings', async (c) => {
      const { board } = await context(c);
      if (!canManageBoard(c, board)) fail(403, 'Only who manages the board can change this');
      const prev = (await stored(c, board.id)) || {};
      const next = cleanSettings(c.body, cleanSettings(prev, prev));
      const err = assertValidSettings(next);
      if (err) fail(400, err);
      await db.put(K.settings(c.org.id, board.id), { ...prev, ...next, updatedBy: c.user.id, updatedAt: now() });
      return json({ settings: next });
    });

    // ------------------------------------------------------------ Jira
    // Uses the Jira account of whoever clicks Sync (My account → Integrations → Jira).
    route('POST', '/api/issues/boards/:boardId/sync', async (c) => {
      const { board } = await context(c);
      const settings = await settingsOf(c, board.id);
      if (settings.source !== 'jira') fail(400, 'This board uses manual issues. Choose Jira in the board settings first.');
      const jira = await integrationFor(c, 'jira');
      if (!jira?.token) fail(400, 'Connect your Jira account first (My account → Integrations → Jira)');
      const auth = `Basic ${btoa(`${jira.email}:${jira.token}`)}`;
      const found = [];
      let nextPageToken;
      try {
        do {
          const res = await globalThis.fetch(`${jira.site}/rest/api/3/search/jql`, {
            method: 'POST',
            headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ jql: jqlFor(settings), maxResults: 100, nextPageToken, fields: ['summary', 'description', 'issuetype', 'status', 'priority', 'assignee', 'reporter', 'labels', 'duedate', 'parent', 'customfield_10020', 'updated'] }),
          });
          if (res.status === 401 || res.status === 403) fail(400, 'Jira rejected your token or you have no access to these issues');
          if (res.status === 400) fail(400, `Jira couldn't run the filter: ${((await res.json().catch(() => ({}))).errorMessages || []).join(' ') || 'check the Team and project'}`);
          if (!res.ok) fail(502, `Jira answered ${res.status}`);
          const page = await res.json();
          found.push(...(page.issues || []));
          nextPageToken = page.nextPageToken;
        } while (nextPageToken && found.length < MAX_JIRA);
      } catch (e) {
        await db.patch(K.settings(c.org.id, board.id), { lastError: e.message, lastAttemptAt: now() }).catch(() => {});
        throw e;
      }
      const existing = new Map((await db.list(K.issues(board.id))).filter((i) => i.source === 'jira').map((i) => [i.externalId, i]));
      const seen = new Set();
      for (const [rank, j] of found.entries()) {
        const data = fromJira(j, jira.site);
        seen.add(data.externalId);
        const prev = existing.get(data.externalId);
        const id = prev?.id || newId();
        await db.put(K.issue(board.id, id), { ...(prev || { createdAt: now() }), ...data, id, boardId: board.id, source: 'jira', rank, syncedAt: now() });
      }
      // issues that left the Team filter leave the backlog
      for (const [ext, i] of existing) if (!seen.has(ext)) await db.delete(K.issue(board.id, i.id));
      const meta = { ...((await stored(c, board.id)) || settings), lastSyncAt: now(), lastError: null, lastCount: found.length, syncedBy: c.user.id };
      await db.put(K.settings(c.org.id, board.id), meta);
      return json({ synced: found.length, removed: [...existing.keys()].filter((k) => !seen.has(k)).length });
    });

    // ------------------------------------------------------------ manual issues
    route('POST', '/api/issues/boards/:boardId/issues', async (c) => {
      const { board, members } = await context(c);
      const i = cleanIssue({ reporterId: c.user.id, ...c.body });
      const err = assertValidIssue(i);
      if (err) fail(400, err);
      await checkRefs(c, board, members, i);
      const meta = (await stored(c, board.id)) || {};
      const settings = cleanSettings(meta, meta);
      const seq = (meta.seq || 0) + 1;
      await db.put(K.settings(c.org.id, board.id), { ...meta, ...settings, seq });
      const all = await db.list(K.issues(board.id));
      const issue = { id: newId(), boardId: board.id, key: `${settings.keyPrefix}-${seq}`, source: 'manual', ...i, rank: all.length ? Math.max(...all.map((x) => x.rank ?? 0)) + 1 : 0, createdBy: c.user.id, createdAt: now(), updatedAt: now() };
      await db.put(K.issue(board.id, issue.id), issue);
      return json({ issue }, 201);
    });

    async function loadIssue(c, board) {
      const issue = await db.get(K.issue(board.id, c.params.id));
      if (!issue) fail(404, 'Issue not found');
      return issue;
    }

    route('GET', '/api/issues/boards/:boardId/issues/:id', async (c) => {
      const { board } = await context(c);
      return json({ issue: await loadIssue(c, board) });
    });

    route('PATCH', '/api/issues/boards/:boardId/issues/:id', async (c) => {
      const { board, members } = await context(c);
      const prev = await loadIssue(c, board);
      if (prev.source === 'jira') {
        // the copy is read-only; only planning it into a sprint happens here
        if (Object.keys(c.body).some((k) => !['sprintId', 'rank'].includes(k))) fail(400, 'Issues from Jira are edited in Jira, then synced');
        const sprintId = c.body.sprintId ? String(c.body.sprintId) : null;
        if (sprintId) await openSprint(board, sprintId);
        const issue = { ...prev, sprintId: sprintId ?? (c.body.sprintId === undefined ? prev.sprintId : null), rank: c.body.rank ?? prev.rank };
        await db.put(K.issue(board.id, issue.id), issue);
        return json({ issue });
      }
      const i = cleanIssue(c.body, prev);
      const err = assertValidIssue(i);
      if (err) fail(400, err);
      if (i.parentId === prev.id) fail(400, "An issue can't be its own parent");
      await checkRefs(c, board, members, i);
      const rank = c.body.rank !== undefined && Number.isFinite(Number(c.body.rank)) ? Number(c.body.rank) : prev.rank;
      const issue = { ...prev, ...i, rank, updatedAt: now(), updatedBy: c.user.id };
      await db.put(K.issue(board.id, issue.id), issue);
      return json({ issue });
    });

    route('DELETE', '/api/issues/boards/:boardId/issues/:id', async (c) => {
      const { board } = await context(c);
      const issue = await loadIssue(c, board);
      if (issue.source === 'jira') fail(400, 'Issues from Jira leave the backlog when they leave the Team filter');
      for (const child of (await db.list(K.issues(board.id))).filter((x) => x.parentId === issue.id)) await db.patch(K.issue(board.id, child.id), { parentId: null });
      await db.delete(K.issue(board.id, issue.id));
      return json({ ok: true });
    });

    // ------------------------------------------------------------ delivery sprints
    async function loadSprintOf(board, id) {
      const sprint = await db.get(K.sprint(board.id, id));
      if (!sprint) fail(404, 'Sprint not found');
      return sprint;
    }

    route('POST', '/api/issues/boards/:boardId/sprints', async (c) => {
      const { board } = await context(c);
      const all = await db.list(K.sprints(board.id));
      const s = cleanSprint({ name: `Sprint ${all.length + 1}`, ...c.body });
      const err = assertValidSprint(s);
      if (err) fail(400, err);
      const sprint = { id: newId(), boardId: board.id, ...s, status: 'planned', retroSprintId: null, createdBy: c.user.id, createdAt: now() };
      await db.put(K.sprint(board.id, sprint.id), sprint);
      return json({ sprint }, 201);
    });

    route('PATCH', '/api/issues/boards/:boardId/sprints/:id', async (c) => {
      const { board } = await context(c);
      const prev = await loadSprintOf(board, c.params.id);
      if (prev.status === 'completed') fail(400, 'A completed sprint is kept as it ended');
      const s = cleanSprint(c.body, prev);
      const err = assertValidSprint(s);
      if (err) fail(400, err);
      const sprint = { ...prev, ...s, updatedAt: now() };
      await db.put(K.sprint(board.id, sprint.id), sprint);
      return json({ sprint });
    });

    route('DELETE', '/api/issues/boards/:boardId/sprints/:id', async (c) => {
      const { board } = await context(c);
      const sprint = await loadSprintOf(board, c.params.id);
      if (sprint.status !== 'planned') fail(400, 'Only a sprint that has not started can be deleted');
      for (const i of (await db.list(K.issues(board.id))).filter((x) => x.sprintId === sprint.id)) await db.patch(K.issue(board.id, i.id), { sprintId: null });
      await db.delete(K.sprint(board.id, sprint.id));
      return json({ ok: true });
    });

    // Start: the sprint's issues start being worked on. One active sprint at a time.
    route('POST', '/api/issues/boards/:boardId/sprints/:id/start', async (c) => {
      const { board } = await context(c);
      const sprint = await loadSprintOf(board, c.params.id);
      if (sprint.status !== 'planned') fail(400, 'This sprint has already started');
      const active = (await db.list(K.sprints(board.id))).find((x) => x.status === 'active');
      if (active) fail(409, `"${active.name}" is still active. Complete it first.`);
      const issues = (await db.list(K.issues(board.id))).filter((x) => x.sprintId === sprint.id);
      if (!issues.length) fail(400, 'Add issues to the sprint before starting it');
      const s = cleanSprint({ startDate: c.body.startDate || sprint.startDate || day(), endDate: c.body.endDate || sprint.endDate || day(13), goal: c.body.goal ?? sprint.goal }, sprint);
      const err = assertValidSprint(s);
      if (err) fail(400, err);
      const next = { ...sprint, ...s, status: 'active', startedAt: now(), startedBy: c.user.id, committed: { issues: issues.length, points: issues.reduce((n, i) => n + (i.storyPoints || 0), 0) } };
      await db.put(K.sprint(board.id, sprint.id), next);
      return json({ sprint: next });
    });

    // Complete: open issues go back to the backlog or to a planned sprint; the
    // board's retro for this sprint can be created from now on.
    route('POST', '/api/issues/boards/:boardId/sprints/:id/complete', async (c) => {
      const { board } = await context(c);
      const sprint = await loadSprintOf(board, c.params.id);
      if (sprint.status !== 'active') fail(400, 'Only an active sprint can be completed');
      const target = c.body.moveOpenTo ? String(c.body.moveOpenTo) : null;
      if (target) {
        const t = await loadSprintOf(board, target);
        if (t.status !== 'planned') fail(400, 'Open issues can move only to a sprint that has not started');
      }
      const issues = (await db.list(K.issues(board.id))).filter((x) => x.sprintId === sprint.id);
      const done = issues.filter((i) => i.status === 'done');
      const open = issues.filter((i) => i.status !== 'done');
      for (const i of open) await db.patch(K.issue(board.id, i.id), { sprintId: target, carriedFrom: sprint.id });
      const next = {
        ...sprint, status: 'completed', completedAt: now(), completedBy: c.user.id, endDate: sprint.endDate || day(),
        result: { done: done.length, open: open.length, donePoints: done.reduce((n, i) => n + (i.storyPoints || 0), 0), doneIssueIds: done.map((i) => i.id), movedTo: target },
      };
      await db.put(K.sprint(board.id, sprint.id), next);
      return json({ sprint: next });
    });

    return {};
  },
});
