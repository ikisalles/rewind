// @rewind/retro — agile retrospectives: team boards → sprints → columns → notes,
// votes, merge, action items, public share links and its dashboard widgets.
//
// Storage keys owned by this module (unchanged from Rewind 0.1, so data carries over):
//   board:{orgId}:{id}  sprint:{boardId}:{id}  sprintref:{id}  note:{sprintId}:{id}
//   vote:{sprintId}:{userId}  action:{sprintId}:{id}  share:{token}

import { defineModule, fail, json, newId, randomToken, now, str, isDate, isColor, isoDay } from '@rewind/core';
import { TEMPLATES, findTemplate, DEFAULT_TEMPLATE } from './templates.js';

export { TEMPLATES };

const MAX_TEXT = 2000;

export const DEFAULT_COLUMNS = findTemplate(DEFAULT_TEMPLATE).columns;

// A note can hold other notes merged into it: all their authors count as contributors.
const noteAuthors = (n) => [n.authorId, ...(n.merged || []).map((m) => m.authorId)];

const K = {
  board: (orgId, id) => `board:${orgId}:${id}`,
  boards: (orgId) => `board:${orgId}:`,
  sprint: (boardId, id) => `sprint:${boardId}:${id}`,
  sprints: (boardId) => `sprint:${boardId}:`,
  sprintRef: (id) => `sprintref:${id}`,
  note: (sprintId, id) => `note:${sprintId}:${id}`,
  notes: (sprintId) => `note:${sprintId}:`,
  vote: (sprintId, userId) => `vote:${sprintId}:${userId}`,
  votes: (sprintId) => `vote:${sprintId}:`,
  action: (sprintId, id) => `action:${sprintId}:${id}`,
  actions: (sprintId) => `action:${sprintId}:`,
  share: (token) => `share:${token}`,
};

export default defineModule({
  id: 'retro',
  name: 'Retro',
  description: 'Agile retrospectives: team boards, sprints with templates, notes, votes, merge and action items.',
  // the only module for now, so every company has it on
  required: true,
  // looked up by an id from the URL or a share token: they should exist
  keyPrefixes: ['board:', 'sprint:', 'sprintref:', 'note:', 'action:', 'share:'],
  register(core) {
    const { db, route, isAdmin, appUrl, teamMembers, getOrg, getTeam, listUsers } = core;

    async function loadBoard(c, boardId) {
      const board = await db.get(K.board(c.org.id, boardId));
      if (!board) fail(404, 'Board not found');
      if (!isAdmin(c) && !c.user.teamIds.includes(board.teamId)) fail(403, "You're not part of this team");
      return board;
    }

    async function loadSprint(c, sprintId) {
      const ref = await db.get(K.sprintRef(sprintId));
      if (!ref || ref.orgId !== c.org.id) fail(404, 'Sprint not found');
      const board = await loadBoard(c, ref.boardId);
      const sprint = await db.get(K.sprint(board.id, sprintId));
      if (!sprint) fail(404, 'Sprint not found');
      return { board, sprint, canManage: isAdmin(c) || board.createdBy === c.user.id };
    }

    const requireOpen = (sprint) => sprint.status === 'finished' && fail(409, 'This retro is finished');
    const requireManage = (canManage) => canManage || fail(403, 'Only the retro admin can do this');

    async function sortedSprints(boardId) {
      const list = await db.list(K.sprints(boardId));
      return list.sort((a, b) => (a.start + a.createdAt).localeCompare(b.start + b.createdAt));
    }

    async function previousSprint(board, sprint) {
      const list = await sortedSprints(board.id);
      const i = list.findIndex((s) => s.id === sprint.id);
      return i > 0 ? list[i - 1] : null;
    }

    const pendingActions = (actions) => actions.filter((a) => a.status === 'open');

    // Builds what a viewer may see of a sprint. viewer = null for public links.
    async function sprintState({ board, sprint, canManage, viewer, members }) {
      const [notes, votes, actions] = await Promise.all([
        db.list(K.notes(sprint.id)),
        db.list(K.votes(sprint.id)),
        db.list(K.actions(sprint.id)),
      ]);
      const count = {};
      for (const v of votes) for (const id of v.noteIds) count[id] = (count[id] || 0) + 1;
      const mine = votes.find((v) => viewer && v.userId === viewer.id)?.noteIds ?? [];
      const names = Object.fromEntries(members.map((m) => [m.id, m.name]));

      const part = (p) => {
        const own = Boolean(viewer && p.authorId === viewer.id);
        const masked = sprint.hidden && !own;
        // anonymous retro: nobody sees who wrote what, the API doesn't send it at all
        const noAuthor = masked || (sprint.anonymous && !own);
        return {
          authorId: noAuthor ? null : p.authorId,
          authorName: noAuthor ? null : names[p.authorId] || 'Former member',
          text: masked ? null : p.text,
          masked,
          mine: own,
        };
      };
      const visibleNotes = notes.map((n) => ({
        id: n.id,
        columnId: n.columnId,
        ...part(n),
        // notes merged into this one (same item or same subject written by different people)
        merged: (n.merged || []).map((m) => ({ id: m.id, ...part(m), createdAt: m.createdAt })),
        votes: count[n.id] || 0,
        votedByMe: mine.includes(n.id),
        myVotes: mine.filter((id) => id === n.id).length,
        createdAt: n.createdAt,
      }));

      const { shareToken, ...publicSprint } = sprint;
      const result = {
        board: { id: board.id, name: board.name, teamId: board.teamId },
        sprint: {
          ...publicSprint,
          // only the retro admin sees the vote budget configuration
          votesPerUser: canManage ? sprint.votesPerUser : undefined,
          shareToken: canManage ? shareToken ?? null : undefined,
        },
        canManage,
        notes: visibleNotes,
        actions,
        members: members.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar })),
      };
      if (viewer) {
        result.myVotes = { used: mine.length, remaining: Math.max(0, sprint.votesPerUser - mine.length) };
        const prev = await previousSprint(board, sprint);
        if (prev) {
          const prevActions = await db.list(K.actions(prev.id));
          result.previous = {
            sprint: { id: prev.id, name: prev.name, start: prev.start, end: prev.end },
            pending: pendingActions(prevActions),
          };
        } else {
          result.previous = null;
        }
      }
      return result;
    }


    function topNotes(notes, votes, n = 3) {
      const count = {};
      for (const v of votes) for (const id of v.noteIds) count[id] = (count[id] || 0) + 1;
      return [...notes]
        .sort((a, b) => (count[b.id] || 0) - (count[a.id] || 0) || a.createdAt.localeCompare(b.createdAt))
        .slice(0, n)
        .map((x) => x.id);
    }


    // ------------------------------------------------------------ public share link
    route('GET', '/api/public/:token', async ({ params }) => {
      const ref = await db.get(K.share(params.token));
      if (!ref) fail(404, 'Invalid or disabled link');
      const board = await db.get(K.board(ref.orgId, ref.boardId));
      const sprint = board && (await db.get(K.sprint(board.id, ref.sprintId)));
      if (!sprint || sprint.shareToken !== params.token) fail(404, 'Invalid or disabled link');
      const org = await getOrg(ref.orgId);
      const members = await teamMembers(ref.orgId, board.teamId);
      const state = await sprintState({ board, sprint, canManage: false, viewer: null, members });
      return json({ ...state, org: { name: org.name, theme: org.theme } });
    }, { public: true });


    // ------------------------------------------------------------ boards
    route('GET', '/api/boards', async (c) => {
      const boards = (await db.list(K.boards(c.org.id))).filter(
        (b) => isAdmin(c) || c.user.teamIds.includes(b.teamId),
      );
      const withCounts = await Promise.all(
        boards.map(async (b) => {
          const sprints = await sortedSprints(b.id);
          const last = sprints.at(-1);
          // never expose the share token or vote budget of the latest sprint here
          const lastSprint = last ? { id: last.id, name: last.name, status: last.status, start: last.start, end: last.end } : null;
          return { ...b, sprintCount: sprints.length, lastSprint };
        }),
      );
      return json({ boards: withCounts });
    });

    route('POST', '/api/boards', async (c) => {
      const name = str(c.body.name, 80) || fail(400, 'Enter the board name');
      const teamId = c.body.teamId;
      if (!(await getTeam(c.org.id, teamId))) fail(400, 'Invalid team');
      if (!isAdmin(c) && !c.user.teamIds.includes(teamId)) fail(403, "You're not part of this team");
      const board = { id: newId(), orgId: c.org.id, teamId, name, createdBy: c.user.id, createdAt: now() };
      await db.put(K.board(c.org.id, board.id), board);
      return json({ board }, 201);
    });

    route('GET', '/api/boards/:id', async (c) => {
      const board = await loadBoard(c, c.params.id);
      const sprints = await sortedSprints(board.id);
      return json({
        board,
        canManage: isAdmin(c) || board.createdBy === c.user.id,
        sprints: sprints.reverse().map(({ shareToken, votesPerUser, ...s }) => s),
      });
    });

    route('PATCH', '/api/boards/:id', async (c) => {
      const board = await loadBoard(c, c.params.id);
      requireManage(isAdmin(c) || board.createdBy === c.user.id);
      board.name = str(c.body.name, 80) || board.name;
      await db.put(K.board(c.org.id, board.id), board);
      return json({ board });
    });

    route('DELETE', '/api/boards/:id', async (c) => {
      const board = await loadBoard(c, c.params.id);
      requireManage(isAdmin(c) || board.createdBy === c.user.id);
      if ((await db.list(K.sprints(board.id))).length) fail(400, "Delete the board's sprints first");
      await db.delete(K.board(c.org.id, board.id));
      return json({ ok: true });
    });

    // ------------------------------------------------------------ sprints
    // A sprint may have no columns (blank start): the retro admin adds them later.
    const cleanColumns = (cols) => {
      if (!Array.isArray(cols)) fail(400, 'Invalid columns');
      const seen = new Set();
      return cols.slice(0, 8).map((col) => {
        let id = str(col.id, 40) || newId();
        if (seen.has(id)) id = newId();
        seen.add(id);
        const hint = str(col.hint, 120);
        return { id, title: str(col.title, 60) || 'Column', color: isColor(col.color) ? col.color : '#f3652b', ...(hint ? { hint } : {}) };
      });
    };

    // How a new sprint starts: a template, blank (no columns) or explicit columns.
    function startingColumns(body) {
      if (body.template === 'blank') return { template: 'blank', columns: [] };
      if (body.template) {
        const t = findTemplate(body.template) || fail(400, 'Unknown template');
        return { template: t.id, columns: t.columns.map((col) => ({ ...col })) };
      }
      if (body.columns !== undefined) return { template: 'custom', columns: cleanColumns(body.columns) };
      return { template: DEFAULT_TEMPLATE, columns: DEFAULT_COLUMNS.map((col) => ({ ...col })) };
    }

    route('GET', '/api/retro/templates', async () => json({ templates: TEMPLATES }));

    route('POST', '/api/boards/:id/sprints', async (c) => {
      const board = await loadBoard(c, c.params.id);
      const name = str(c.body.name, 80) || fail(400, 'Enter the sprint name');
      if (!isDate(c.body.start) || !isDate(c.body.end)) fail(400, 'Enter valid dates');
      if (c.body.end < c.body.start) fail(400, 'The end date must be after the start date');
      const { template, columns } = startingColumns(c.body);
      const sprint = {
        id: newId(),
        boardId: board.id,
        name,
        start: c.body.start,
        end: c.body.end,
        template,
        columns,
        hidden: true,
        anonymous: false,
        votesPerUser: 3,
        status: 'open',
        top: [],
        shareToken: null,
        createdBy: c.user.id,
        createdAt: now(),
        finishedAt: null,
      };
      await db.put(K.sprint(board.id, sprint.id), sprint);
      await db.put(K.sprintRef(sprint.id), { orgId: c.org.id, boardId: board.id });
      return json({ sprint }, 201);
    });

    route('GET', '/api/sprints/:id', async (c) => {
      const { board, sprint, canManage } = await loadSprint(c, c.params.id);
      const members = await teamMembers(c.org.id, board.teamId);
      return json(await sprintState({ board, sprint, canManage, viewer: c.user, members }));
    });

    route('PATCH', '/api/sprints/:id', async (c) => {
      const { board, sprint, canManage } = await loadSprint(c, c.params.id);
      requireManage(canManage);
      const b = c.body;
      if (b.name !== undefined) sprint.name = str(b.name, 80) || sprint.name;
      if (b.start !== undefined && isDate(b.start)) sprint.start = b.start;
      if (b.end !== undefined && isDate(b.end)) sprint.end = b.end;
      if (sprint.end < sprint.start) fail(400, 'The end date must be after the start date');
      if (b.hidden !== undefined) sprint.hidden = Boolean(b.hidden);
      if (b.anonymous !== undefined) sprint.anonymous = Boolean(b.anonymous);
      if (b.votesPerUser !== undefined) {
        const n = Number(b.votesPerUser);
        if (!Number.isInteger(n) || n < 0 || n > 50) fail(400, 'Votes must be between 0 and 50');
        sprint.votesPerUser = n;
      }
      if (b.columns !== undefined || b.template !== undefined) {
        requireOpen(sprint);
        const columns = b.template ? (findTemplate(b.template) || fail(400, 'Unknown template')).columns.map((col) => ({ ...col })) : cleanColumns(b.columns);
        const notes = await db.list(K.notes(sprint.id));
        if (!columns.length && notes.length) fail(400, 'Keep at least one column: this retro already has notes');
        sprint.columns = columns;
        if (b.template) sprint.template = b.template;
        // notes of removed columns go to the first column, nothing is lost
        const ids = new Set(sprint.columns.map((col) => col.id));
        for (const note of notes) {
          if (!ids.has(note.columnId)) {
            note.columnId = sprint.columns[0].id;
            await db.put(K.note(sprint.id, note.id), note);
          }
        }
      }
      await db.put(K.sprint(board.id, sprint.id), sprint);
      return json({ ok: true });
    });

    route('DELETE', '/api/sprints/:id', async (c) => {
      const { board, sprint, canManage } = await loadSprint(c, c.params.id);
      requireManage(canManage);
      const kinds = [K.notes(sprint.id), K.votes(sprint.id), K.actions(sprint.id)];
      for (const prefix of kinds) {
        for (const item of await db.list(prefix)) {
          await db.delete(prefix + (item.id ?? item.userId));
        }
      }
      if (sprint.shareToken) await db.delete(K.share(sprint.shareToken));
      await db.delete(K.sprintRef(sprint.id));
      await db.delete(K.sprint(board.id, sprint.id));
      return json({ ok: true });
    });

    route('POST', '/api/sprints/:id/share', async (c) => {
      const { board, sprint, canManage } = await loadSprint(c, c.params.id);
      requireManage(canManage);
      if (c.body.enabled === false) {
        if (sprint.shareToken) await db.delete(K.share(sprint.shareToken));
        sprint.shareToken = null;
      } else if (!sprint.shareToken) {
        sprint.shareToken = randomToken(18);
        await db.put(K.share(sprint.shareToken), { orgId: c.org.id, boardId: board.id, sprintId: sprint.id });
      }
      await db.put(K.sprint(board.id, sprint.id), sprint);
      return json({
        shareToken: sprint.shareToken,
        url: sprint.shareToken ? `${appUrl(c.req)}/#/s/${sprint.shareToken}` : null,
      });
    });

    route('POST', '/api/sprints/:id/finish', async (c) => {
      const { board, sprint, canManage } = await loadSprint(c, c.params.id);
      requireManage(canManage);
      const [notes, votes] = await Promise.all([db.list(K.notes(sprint.id)), db.list(K.votes(sprint.id))]);
      sprint.status = 'finished';
      sprint.hidden = false; // results are visible to everyone once the retro is over
      sprint.finishedAt = now();
      sprint.top = topNotes(notes, votes);
      await db.put(K.sprint(board.id, sprint.id), sprint);
      return json({ top: sprint.top });
    });

    route('POST', '/api/sprints/:id/reopen', async (c) => {
      const { board, sprint, canManage } = await loadSprint(c, c.params.id);
      requireManage(canManage);
      sprint.status = 'open';
      sprint.finishedAt = null;
      await db.put(K.sprint(board.id, sprint.id), sprint);
      return json({ ok: true });
    });

    // ------------------------------------------------------------ notes (post-its)
    route('POST', '/api/sprints/:id/notes', async (c) => {
      const { sprint } = await loadSprint(c, c.params.id);
      requireOpen(sprint);
      const text = str(c.body.text, MAX_TEXT) || fail(400, 'Write something on the note');
      if (!sprint.columns.some((col) => col.id === c.body.columnId)) fail(400, 'Invalid column');
      const note = { id: newId(), columnId: c.body.columnId, authorId: c.user.id, text, createdAt: now() };
      await db.put(K.note(sprint.id, note.id), note);
      return json({ note }, 201);
    });

    route('PATCH', '/api/sprints/:id/notes/:noteId', async (c) => {
      const { sprint } = await loadSprint(c, c.params.id);
      requireOpen(sprint);
      const note = (await db.get(K.note(sprint.id, c.params.noteId))) || fail(404, 'Note not found');
      if (note.authorId !== c.user.id) fail(403, 'Only the author can edit this note');
      if (c.body.text !== undefined) note.text = str(c.body.text, MAX_TEXT) || fail(400, 'Write something on the note');
      if (c.body.columnId !== undefined) {
        if (!sprint.columns.some((col) => col.id === c.body.columnId)) fail(400, 'Invalid column');
        note.columnId = c.body.columnId;
      }
      await db.put(K.note(sprint.id, note.id), note);
      return json({ note });
    });

    route('DELETE', '/api/sprints/:id/notes/:noteId', async (c) => {
      const { sprint, canManage } = await loadSprint(c, c.params.id);
      requireOpen(sprint);
      const note = (await db.get(K.note(sprint.id, c.params.noteId))) || fail(404, 'Note not found');
      if (note.authorId !== c.user.id && !canManage) fail(403, 'Only the author can delete this note');
      if (note.merged?.length && !canManage) fail(403, 'This note has other notes merged into it: only the retro admin can remove it');
      await db.delete(K.note(sprint.id, note.id));
      // drop the votes that pointed to it, giving them back
      for (const v of await db.list(K.votes(sprint.id))) {
        if (v.noteIds.includes(note.id)) {
          v.noteIds = v.noteIds.filter((id) => id !== note.id);
          await db.put(K.vote(sprint.id, v.userId), v);
        }
      }
      return json({ ok: true });
    });

    // ------------------------------------------------------------ merge notes
    // The retro admin groups notes about the same thing. The target keeps its text and
    // holds the others (text and author preserved), so nothing is lost and it can be undone.
    route('POST', '/api/sprints/:id/notes/:noteId/merge', async (c) => {
      const { sprint, canManage } = await loadSprint(c, c.params.id);
      requireOpen(sprint);
      const target = (await db.get(K.note(sprint.id, c.params.noteId))) || fail(404, 'Note not found');
      const ids = [...new Set((Array.isArray(c.body.noteIds) ? c.body.noteIds : [c.body.noteId]).filter((id) => id && id !== target.id))];
      if (!ids.length) fail(400, 'Pick the notes to merge');
      const sources = await Promise.all(ids.map((id) => db.get(K.note(sprint.id, id))));
      if (sources.some((n) => !n)) fail(404, 'Note not found');
      // Anyone merges the notes they can read: the retro admin any revealed note,
      // everyone their own notes (even while notes are hidden from the others).
      const all = [target, ...sources];
      const ownsAll = (n) => noteAuthors(n).every((id) => id === c.user.id);
      if (sprint.hidden && !all.every(ownsAll)) fail(409, "Reveal the notes before merging other people's notes");
      if (!canManage && !all.every(ownsAll)) fail(403, 'You can only merge your own notes; the retro admin can merge any note');

      target.merged = target.merged || [];
      for (const src of sources) {
        target.merged.push({ id: src.id, authorId: src.authorId, text: src.text, columnId: src.columnId, createdAt: src.createdAt }, ...(src.merged || []));
      }
      await db.put(K.note(sprint.id, target.id), target);
      for (const src of sources) await db.delete(K.note(sprint.id, src.id));

      // votes follow the card (a person may have several votes on the same card)
      const moved = new Set(ids);
      for (const v of await db.list(K.votes(sprint.id))) {
        if (!v.noteIds.some((id) => moved.has(id))) continue;
        v.noteIds = v.noteIds.map((id) => (moved.has(id) ? target.id : id));
        await db.put(K.vote(sprint.id, v.userId), v);
      }
      // action items created from a merged note now point to the merged card
      for (const a of await db.list(K.actions(sprint.id))) {
        if (moved.has(a.noteId)) {
          a.noteId = target.id;
          await db.put(K.action(sprint.id, a.id), a);
        }
      }
      return json({ note: target });
    });

    route('POST', '/api/sprints/:id/notes/:noteId/unmerge', async (c) => {
      const { sprint, canManage } = await loadSprint(c, c.params.id);
      requireOpen(sprint);
      const target = (await db.get(K.note(sprint.id, c.params.noteId))) || fail(404, 'Note not found');
      const part = (target.merged || []).find((m) => m.id === c.body.mergedId) || fail(404, 'Merged note not found');
      if (!canManage && !noteAuthors(target).every((id) => id === c.user.id)) fail(403, 'Only the retro admin can split notes written by other people');
      target.merged = target.merged.filter((m) => m.id !== part.id);
      await db.put(K.note(sprint.id, target.id), target);
      // back as its own card, in its original column when that column still exists (votes stay on the merged card)
      const columnId = sprint.columns.some((col) => col.id === part.columnId) ? part.columnId : target.columnId;
      const note = { id: part.id, columnId, authorId: part.authorId, text: part.text, createdAt: part.createdAt };
      await db.put(K.note(sprint.id, note.id), note);
      return json({ note });
    });

    // ------------------------------------------------------------ votes
    route('POST', '/api/sprints/:id/notes/:noteId/vote', async (c) => {
      const { sprint } = await loadSprint(c, c.params.id);
      requireOpen(sprint);
      if (!(await db.get(K.note(sprint.id, c.params.noteId)))) fail(404, 'Note not found');
      // One entry per vote: the same card can get several of a person's votes,
      // as long as the total stays within the sprint's votes per person.
      const v = (await db.get(K.vote(sprint.id, c.user.id))) || { userId: c.user.id, noteIds: [] };
      if (v.noteIds.length >= sprint.votesPerUser) fail(409, "You've used all your votes");
      v.noteIds.push(c.params.noteId);
      await db.put(K.vote(sprint.id, c.user.id), v);
      return json({ remaining: sprint.votesPerUser - v.noteIds.length, onNote: v.noteIds.filter((id) => id === c.params.noteId).length });
    });

    route('DELETE', '/api/sprints/:id/notes/:noteId/vote', async (c) => {
      const { sprint } = await loadSprint(c, c.params.id);
      requireOpen(sprint);
      // takes back one of your votes on this card
      const v = (await db.get(K.vote(sprint.id, c.user.id))) || { userId: c.user.id, noteIds: [] };
      const i = v.noteIds.lastIndexOf(c.params.noteId);
      if (i >= 0) v.noteIds.splice(i, 1);
      await db.put(K.vote(sprint.id, c.user.id), v);
      return json({ remaining: Math.max(0, sprint.votesPerUser - v.noteIds.length), onNote: v.noteIds.filter((id) => id === c.params.noteId).length });
    });

    // ------------------------------------------------------------ action items
    async function validOwner(c, board, ownerId) {
      if (!ownerId) return null;
      const members = await teamMembers(c.org.id, board.teamId);
      return members.some((m) => m.id === ownerId) ? ownerId : fail(400, 'Invalid owner');
    }

    route('POST', '/api/sprints/:id/actions', async (c) => {
      const { board, sprint, canManage } = await loadSprint(c, c.params.id);
      requireManage(canManage);
      const action = {
        id: newId(),
        sprintId: sprint.id,
        noteId: c.body.noteId || null,
        text: str(c.body.text, 500) || fail(400, 'Describe the action item'),
        ownerId: await validOwner(c, board, c.body.ownerId),
        due: isDate(c.body.due) ? c.body.due : null,
        done: false,
        status: 'open',
        carriedFrom: null,
        createdAt: now(),
      };
      await db.put(K.action(sprint.id, action.id), action);
      return json({ action }, 201);
    });

    route('PATCH', '/api/sprints/:id/actions/:actionId', async (c) => {
      const { board, sprint, canManage } = await loadSprint(c, c.params.id);
      const action = (await db.get(K.action(sprint.id, c.params.actionId))) || fail(404, 'Action item not found');
      const isOwner = action.ownerId === c.user.id;
      if (!canManage && !isOwner) fail(403, 'Only the admin or the owner can do this');
      if (c.body.done !== undefined) {
        action.done = Boolean(c.body.done);
        action.status = action.done ? 'done' : 'open';
      }
      if (canManage) {
        if (c.body.text !== undefined) action.text = str(c.body.text, 500) || action.text;
        if (c.body.ownerId !== undefined) action.ownerId = await validOwner(c, board, c.body.ownerId);
        if (c.body.due !== undefined) action.due = isDate(c.body.due) ? c.body.due : null;
      }
      await db.put(K.action(sprint.id, action.id), action);
      return json({ action });
    });

    route('DELETE', '/api/sprints/:id/actions/:actionId', async (c) => {
      const { sprint, canManage } = await loadSprint(c, c.params.id);
      requireManage(canManage);
      await db.delete(K.action(sprint.id, c.params.actionId));
      return json({ ok: true });
    });

    // Review the unfinished action items of the previous sprint:
    //   keep  -> carried into this sprint (still open)
    //   done  -> marked as done in the previous sprint
    //   drop  -> no longer makes sense
    route('POST', '/api/sprints/:id/review', async (c) => {
      const { board, sprint, canManage } = await loadSprint(c, c.params.id);
      requireManage(canManage);
      const prev = (await previousSprint(board, sprint)) || fail(400, 'There is no previous sprint');
      const action = (await db.get(K.action(prev.id, c.body.actionId))) || fail(404, 'Action item not found');
      const decision = c.body.decision;
      if (decision === 'keep') {
        const copy = {
          ...action,
          id: newId(),
          sprintId: sprint.id,
          noteId: null,
          carriedFrom: { sprintId: prev.id, actionId: action.id, sprintName: prev.name },
          createdAt: now(),
        };
        await db.put(K.action(sprint.id, copy.id), copy);
        action.status = 'carried';
      } else if (decision === 'done') {
        action.status = 'done';
        action.done = true;
      } else if (decision === 'drop') {
        action.status = 'dropped';
      } else {
        fail(400, 'Invalid decision');
      }
      await db.put(K.action(prev.id, action.id), action);
      return json({ action });
    });

    // ------------------------------------------------------------ my action items
    const visibleBoards = async (c) =>
      (await db.list(K.boards(c.org.id))).filter((b) => isAdmin(c) || c.user.teamIds.includes(b.teamId));

    // Open action items owned by the viewer. `sprintsOf` lets callers reuse sprint lists they already loaded.
    async function myOpenActions(c, boards, sprintsOf = (b) => db.list(K.sprints(b.id))) {
      const perBoard = await Promise.all(
        boards.map(async (board) => {
          const sprints = await sprintsOf(board);
          const perSprint = await Promise.all(
            sprints.map(async (sprint) =>
              (await db.list(K.actions(sprint.id)))
                .filter((a) => a.ownerId === c.user.id && a.status === 'open')
                .map((a) => ({ ...a, board: { id: board.id, name: board.name }, sprint: { id: sprint.id, name: sprint.name } })),
            ),
          );
          return perSprint.flat();
        }),
      );
      return perBoard.flat().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    }

    route('GET', '/api/actions/mine', async (c) => json({ actions: await myOpenActions(c, await visibleBoards(c)) }));


    // ------------------------------------------------------------ dashboard
    // The retro part of /api/dashboard: boards, the viewer's open action items, the
    // open retros waiting on them, the latest retro results and team health.
    const CLOSING_SOON_DAYS = 2;
    const HEALTH_SPRINTS = 6;
    const STALE_DAYS = 28;


    // done / everything that was not dropped; null when nothing was committed to.
    function actionProgress(actions) {
      const committed = actions.filter((a) => a.status !== 'dropped');
      const done = committed.filter((a) => a.status === 'done').length;
      return { done, total: committed.length, rate: committed.length ? done / committed.length : null };
    }

    async function boardDashboard(c, board, sprints, teamSize) {
      const canManage = isAdmin(c) || board.createdBy === c.user.id;
      const inTeam = c.user.teamIds.includes(board.teamId);
      const recent = sprints.slice(-HEALTH_SPRINTS);
      const latestFinished = sprints.findLast((s) => s.status === 'finished') ?? null;
      const latest = sprints.at(-1) ?? null;

      // Load notes and action items once per recent sprint (+ the latest finished one if older).
      const toLoad = [...recent];
      if (latestFinished && !toLoad.includes(latestFinished)) toLoad.push(latestFinished);
      const data = new Map(
        await Promise.all(
          toLoad.map(async (s) => [s.id, { notes: await db.list(K.notes(s.id)), actions: await db.list(K.actions(s.id)) }]),
        ),
      );

      // Team health, oldest -> newest.
      const health = recent.map((s) => {
        const { notes, actions } = data.get(s.id);
        const authors = new Set(notes.flatMap(noteAuthors)).size;
        const progress = actionProgress(actions);
        return {
          sprint: { id: s.id, name: s.name, end: s.end, status: s.status },
          actions: progress,
          participation: { authors, teamSize, rate: teamSize ? Math.min(1, authors / teamSize) : null },
          carried: actions.filter((a) => a.status === 'carried').length,
        };
      });

      // Latest retro result: top voted notes and how its action items are going.
      let result = null;
      if (latestFinished) {
        const { notes, actions } = data.get(latestFinished.id);
        const votes = await db.list(K.votes(latestFinished.id));
        const count = {};
        for (const v of votes) for (const id of v.noteIds) count[id] = (count[id] || 0) + 1;
        const columns = Object.fromEntries(latestFinished.columns.map((col) => [col.id, col]));
        result = {
          sprint: { id: latestFinished.id, name: latestFinished.name, end: latestFinished.end, finishedAt: latestFinished.finishedAt },
          top: latestFinished.top
            .map((id) => notes.find((n) => n.id === id))
            .filter(Boolean)
            .map((n) => ({
              id: n.id,
              // the admin may hide notes again after finishing: respect it
              text: latestFinished.hidden && n.authorId !== c.user.id ? null : n.text,
              mergedCount: (n.merged || []).length,
              votes: count[n.id] || 0,
              column: columns[n.columnId] ? { title: columns[n.columnId].title, color: columns[n.columnId].color } : null,
            })),
          actions: actionProgress(actions),
        };
      }

      // Needs your attention: only the latest sprint, older open ones are not worth nagging about.
      let attention = null;
      if (latest?.status === 'open' && (inTeam || canManage)) {
        const [notes, myVote] = await Promise.all([
          data.get(latest.id)?.notes ?? db.list(K.notes(latest.id)),
          db.get(K.vote(latest.id, c.user.id)),
        ]);
        const needsNote = inTeam && !notes.some((n) => noteAuthors(n).includes(c.user.id));
        const votesRemaining = inTeam && notes.length ? Math.max(0, latest.votesPerUser - (myVote?.noteIds.length ?? 0)) : 0;
        const closingSoon = canManage && latest.end <= isoDay(CLOSING_SOON_DAYS);
        if (needsNote || votesRemaining || closingSoon) {
          attention = {
            board: { id: board.id, name: board.name, teamId: board.teamId },
            sprint: { id: latest.id, name: latest.name, start: latest.start, end: latest.end },
            needsNote,
            votesRemaining,
            closingSoon,
          };
        }
      }

      return {
        board: {
          ...board,
          sprintCount: sprints.length,
          lastSprint: latest ? { id: latest.id, name: latest.name, status: latest.status, start: latest.start, end: latest.end } : null,
        },
        attention,
        result: result && { board: { id: board.id, name: board.name, teamId: board.teamId }, ...result },
        health: { board: { id: board.id, name: board.name, teamId: board.teamId }, sprints: health },
      };
    }

    async function adminDashboard(c) {
      const boards = await db.list(K.boards(c.org.id));
      const sprintsByBoard = new Map(await Promise.all(boards.map(async (b) => [b.id, await sortedSprints(b.id)])));
      const staleSince = isoDay(-STALE_DAYS);
      const staleBoards = boards
        .map((b) => {
          const last = sprintsByBoard.get(b.id).at(-1);
          return { id: b.id, name: b.name, lastActivity: last ? last.end : b.createdAt.slice(0, 10), hasSprints: Boolean(last) };
        })
        .filter((b) => b.lastActivity < staleSince)
        .sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));
      const allSprints = [...sprintsByBoard.values()].flat();
      return {
        onboarding: {
          board: boards.length > 0,
          sprint: allSprints.length > 0,
          finished: allSprints.some((s) => s.status === 'finished'),
        },
        staleBoards,
      };
    }

    async function dashboard(c) {
      const [boards, users] = await Promise.all([visibleBoards(c), listUsers(c.org.id)]);
      const sprintsByBoard = new Map(await Promise.all(boards.map(async (b) => [b.id, await sortedSprints(b.id)])));
      const teamSize = (teamId) => users.filter((u) => u.teamIds.includes(teamId)).length;

      const [perBoard, actions] = await Promise.all([
        Promise.all(boards.map((b) => boardDashboard(c, b, sprintsByBoard.get(b.id), teamSize(b.teamId)))),
        myOpenActions(c, boards, (b) => sprintsByBoard.get(b.id)),
      ]);

      return {
        boards: perBoard.map((x) => x.board),
        actions,
        attention: perBoard.map((x) => x.attention).filter(Boolean).sort((a, b) => a.sprint.end.localeCompare(b.sprint.end)),
        results: perBoard
          .map((x) => x.result)
          .filter(Boolean)
          .sort((a, b) => (b.sprint.finishedAt || '').localeCompare(a.sprint.finishedAt || '')),
        health: perBoard.map((x) => x.health).filter((x) => x.sprints.length),
      };
    }

    async function beforeTeamDelete(c, teamId) {
      const boards = await db.list(K.boards(c.org.id));
      if (boards.some((b) => b.teamId === teamId)) fail(400, "Delete this team's boards first");
    }

    return { dashboard, adminDashboard, beforeTeamDelete };
  },
});
