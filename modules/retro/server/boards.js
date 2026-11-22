// Published helpers for modules that live inside a team board (e.g. issues).
// They read the board through retro's own rules, so other modules never need
// to know retro's keys or access policy.
import { fail } from '@rewind/core';

export const boardKey = (orgId, id) => `board:${orgId}:${id}`;
export const sprintsPrefix = (boardId) => `sprint:${boardId}:`;

const isAdmin = (c) => c.user?.role === 'admin';
export const canAccessBoard = (c, board) => isAdmin(c) || (c.user?.teamIds || []).includes(board.teamId);
export const canManageBoard = (c, board) => isAdmin(c) || board.createdBy === c.user?.id;

// The board, if it exists and the user is in its team (or is an admin).
export async function loadBoard(db, c, boardId) {
  const board = await db.get(boardKey(c.org.id, boardId));
  if (!board) fail(404, 'Board not found');
  if (!canAccessBoard(c, board)) fail(403, "You're not part of this team");
  return board;
}

// The board's sprints (id, name, status, dates), oldest first.
export async function boardSprints(db, boardId) {
  const list = await db.list(sprintsPrefix(boardId));
  return list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')).map(({ id, name, status, start, end }) => ({ id, name, status, start, end }));
}

// Modules that keep data inside a board clean it up when the board goes away.
const deleteHooks = new Set();
export const onBoardDelete = (fn) => deleteHooks.add(fn);
export async function runBoardDeleteHooks(db, orgId, board) {
  for (const fn of deleteHooks) await fn(db, orgId, board);
}

// Modules that drive the board's flow can gate when a retro is created
// (e.g. only when a delivery sprint ends) and learn which retro was created.
// before(db, c, board, body) fails to refuse; after(db, c, board, retroSprint, body).
const createHooks = new Set();
export const onRetroCreate = (hooks) => createHooks.add(hooks);
export async function runRetroCreateHooks(phase, ...args) {
  for (const h of createHooks) await h[phase]?.(...args);
}
