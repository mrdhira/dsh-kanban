/**
 * Parsing and importing the pre-Kanban board.
 *
 * The parser is deliberately forgiving about *shape* (column counts, an unknown state) and strict
 * about *claims*: an imported row is ticked only for the Definition of Ready items the row
 * actually carries. A test that let the importer invent evidence would be a test endorsing the
 * exact failure the board exists to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTask,
  importTodoMd,
  listTasks,
  parseTodoMd,
} from '../lib/v1/store/index.js';
import { HUMAN, NOW, newBoard } from './helpers.ts';

/** A table shaped like the real `tasks/todo.md`, with one row of each interesting kind. */
const TABLE = [
  '# Board',
  '',
  '| ID | Task | State | Owner | Write scope | Acceptance | Links |',
  '|---|---|---|---|---|---|---|',
  '| T-001 | Badge for `dsh-session-metrics` | done | 3 engineers | `~/.dsh/profiles/desktop/dsh-session-metrics/**` | badge renders without an empty state | [requirements](T-001-badge-status-tag/requirements.md) |',
  '| T-002 | Detect a stale host build | planned | lead | `~/.dsh/docs/**` | a reader can tell whether a restart is needed | [req](T-002-host-restart/requirements.md) |',
  '| T-003 | Something blocked | blocked | lead | — | — | — |',
  '| T-004 | A row with no links | inbox | — | — | — | — |',
].join('\n');

// ------------------------------------------------------------------ positive cases

test('every T-### row is read, and the header and separator are not', () => {
  const rows = parseTodoMd(TABLE);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['T-001', 'T-002', 'T-003', 'T-004']
  );
});

test('a row keeps its title, state, owner, scope and acceptance', () => {
  const [row] = parseTodoMd(TABLE);
  assert.equal(row?.title, 'Badge for dsh-session-metrics');
  assert.equal(row?.state, 'done');
  assert.equal(row?.assignee, '3 engineers');
  assert.equal(row?.writeScope, '~/.dsh/profiles/desktop/dsh-session-metrics/**');
  assert.equal(row?.acceptance, 'badge renders without an empty state');
});

test('the legacy states are mapped onto the board vocabulary', () => {
  const rows = parseTodoMd(TABLE);
  assert.equal(rows[0]?.state, 'done');
  assert.equal(rows[1]?.state, 'ready');
  assert.equal(rows[3]?.state, 'backlog');
});

test('a blocked row becomes work in progress with a blocked flag', () => {
  const row = parseTodoMd(TABLE)[2];
  assert.equal(row?.state, 'in-progress');
  assert.equal(row?.blockedReason, 'marked blocked on the pre-Kanban board');
});

test('a markdown link becomes a link, and the folder comes from its first segment', () => {
  const row = parseTodoMd(TABLE)[0];
  assert.deepEqual(row?.links, [
    { kind: 'file', ref: 'T-001-badge-status-tag/requirements.md', label: 'requirements' },
  ]);
  assert.equal(row?.folder, 'tasks/T-001-badge-status-tag');
});

test('an em dash is treated as an absent value, not as text', () => {
  const row = parseTodoMd(TABLE)[3];
  assert.equal(row?.assignee, null);
  assert.equal(row?.acceptance, null);
  assert.equal(row?.folder, null);
});

// ------------------------------------------------------------------ negative cases

test('a row whose state is unknown lands in the backlog rather than being dropped', () => {
  const rows = parseTodoMd('| T-009 | strange | wibble | — | — | — | — |');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.state, 'backlog');
});

test('a row with fewer columns does not throw', () => {
  const rows = parseTodoMd('| T-010 | short row |');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, 'short row');
  assert.equal(rows[0]?.acceptance, null);
});

test('lines that are not task rows are ignored', () => {
  assert.deepEqual(parseTodoMd('just prose\n\n- a bullet\n| not an id | x |'), []);
});

test('an http link is marked as a url rather than a file', () => {
  const rows = parseTodoMd('| T-011 | x | inbox | — | — | — | [docs](https://example.com/a) |');
  assert.deepEqual(rows[0]?.links, [{ kind: 'url', ref: 'https://example.com/a', label: 'docs' }]);
});

// ------------------------------------------------------------------ the import

test('importing creates a card per row, with the id preserved', () => {
  const board = newBoard();
  const result = importTodoMd(board, TABLE, { actor: HUMAN, now: NOW });
  assert.deepEqual([...result.imported], ['T-001', 'T-002', 'T-003', 'T-004']);
  assert.equal(listTasks(board, { limit: 10 }).total, 4);
  assert.equal(getTask(board, 'T-001')?.title, 'Badge for dsh-session-metrics');
  board.close();
});

test('importing ticks only the DoR checks the row can evidence', () => {
  const board = newBoard();
  importTodoMd(board, TABLE, { actor: HUMAN, now: NOW });
  const full = getTask(board, 'T-001');
  assert.deepEqual(Object.keys(full?.dor ?? {}).sort(), ['acceptance', 'outcome', 'write-scope']);
  assert.equal(full?.dor.estimate, undefined, 'size was never recorded, so it is not claimed');
  assert.equal(full?.dod.evidence, undefined, 'a done row does not get an invented DoD');
  assert.match(full?.description ?? '', /before this board had a Definition of Done/);
  board.close();
});

test('a sparse row is ticked only for its title', () => {
  const board = newBoard();
  importTodoMd(board, '| T-020 | just a title | inbox | — | — | — | — |', { actor: HUMAN, now: NOW });
  assert.deepEqual(Object.keys(getTask(board, 'T-020')?.dor ?? {}), ['outcome']);
  board.close();
});

test('importing twice imports nothing the second time', () => {
  const board = newBoard();
  importTodoMd(board, TABLE, { actor: HUMAN, now: NOW });
  const again = importTodoMd(board, TABLE, { actor: HUMAN, now: NOW });
  assert.equal(again.imported.length, 0);
  assert.deepEqual([...again.skipped], ['T-001', 'T-002', 'T-003', 'T-004']);
  assert.equal(listTasks(board, { limit: 10 }).total, 4);
  board.close();
});

test('an imported blocked row carries its flag', () => {
  const board = newBoard();
  importTodoMd(board, TABLE, { actor: HUMAN, now: NOW });
  assert.equal(getTask(board, 'T-003')?.blockedReason, 'marked blocked on the pre-Kanban board');
  board.close();
});

test('the import leaves the board revision ahead of where it started', () => {
  const board = newBoard();
  const before = listTasks(board, { limit: 1 }).total;
  assert.equal(before, 0);
  importTodoMd(board, TABLE, { actor: HUMAN, now: NOW });
  assert.equal(listTasks(board, { limit: 1 }).total, 4);
  board.close();
});
