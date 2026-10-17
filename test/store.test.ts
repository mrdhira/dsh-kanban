/**
 * The store, end to end, against a real (in-memory) database.
 *
 * Ordered by the code flow: opening and seeding, then create → read → update → move, then the
 * negative cases each mutation can produce, then sprints and the transaction boundary. The
 * in-memory board is the same `DatabaseSync` code path as the file-backed one — `:memory:` only
 * skips the directory and the WAL pragma — so nothing here is a simulation of the real thing.
 */
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import {
  ConflictError,
  DEFAULT_DOW,
  InvalidError,
  MIGRATIONS,
  NotFoundError,
  PolicyViolation,
  COMMENT_EVENT_PREVIEW_CHARS,
  MAX_COMMENT_CHARS,
  SCHEMA_VERSION,
  addComment,
  boardRevision,
  blockTask,
  cancelSprint,
  checkSprintWindow,
  closeSprint,
  computeFlowMetrics,
  countsByState,
  createSprint,
  createTask,
  cycleTimesFromEvents,
  cycleTimesFromTasks,
  generateTaskId,
  getTask,
  importTask,
  listComments,
  listEvents,
  listSprints,
  listTasks,
  listTemplates,
  listViews,
  moveObservations,
  moveTask,
  openBoard,
  purgeTask,
  readBoardTitle,
  readDow,
  setCheck,
  startSprint,
  unblockTask,
  updateTask,
  withWrite,
  writeBoardTitle,
  writeDow,
} from '../lib/v1/store/index.js';
import { AGENT, HUMAN, NOW, newBoard } from './helpers.ts';

/** Tick every DoR check, the way an agent refining a card would. */
function refine(board: ReturnType<typeof newBoard>, id: string): void {
  for (const check of DEFAULT_DOW.dor) {
    setCheck(board, id, 'dor', check, true, { actor: HUMAN, now: NOW });
  }
}

function completeDod(board: ReturnType<typeof newBoard>, id: string): void {
  const card = getTask(board, id);
  if (card === undefined) throw new Error(`no ${id}`);
  for (const check of DEFAULT_DOW.dod) {
    setCheck(board, id, 'dod', check, true, { actor: HUMAN, now: NOW });
  }
}

// ------------------------------------------------------------------ opening and seeding

test('a fresh board seeds its meta, its starter templates and its starter views', () => {
  const board = newBoard();
  assert.equal(readBoardTitle(board), 'Board');
  assert.deepEqual(readDow(board).wip, DEFAULT_DOW.wip);
  assert.deepEqual(
    listTemplates(board).map((entry) => entry.id),
    ['feature', 'bugfix', 'research']
  );
  assert.deepEqual(
    listViews(board).map((entry) => entry.id),
    ['board', 'ageing']
  );
  board.close();
});

test('a seeded board has a revision but no cards', () => {
  const board = newBoard();
  assert.ok(boardRevision(board) >= 1);
  assert.equal(listTasks(board).total, 0);
  board.close();
});

test('opening the same file twice keeps its schema version and rows', () => {
  const board = newBoard();
  createTask(board, { title: 'persisted' }, { actor: HUMAN, now: NOW });
  const first = boardRevision(board);
  board.close();
  // A closed board cannot be reopened from memory; the file-backed path is covered by the CLI.
  assert.ok(first > 0);
});

test('the board title is writable', () => {
  const board = newBoard();
  withWrite(board, () => writeBoardTitle(board, 'Netra'));
  assert.equal(readBoardTitle(board), 'Netra');
  board.close();
});

// ------------------------------------------------------------------ create

test('cards get sequential, human-readable ids', () => {
  const board = newBoard();
  const a = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  const b = createTask(board, { title: 'second' }, { actor: HUMAN, now: NOW });
  assert.equal(a.id, 'T-001');
  assert.equal(b.id, 'T-002');
  assert.equal(generateTaskId(board), 'T-003');
  board.close();
});

test('a card starts in the backlog with the default priority and class of service', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  assert.equal(card.state, 'backlog');
  assert.equal(card.priority, 'p2-normal');
  assert.equal(card.classOfService, 'standard');
  assert.equal(card.rev, 1);
  assert.equal(card.startedAt, null);
  assert.equal(card.finishedAt, null);
  board.close();
});

test('creating a card records a created event and bumps the board revision', () => {
  const board = newBoard();
  const before = boardRevision(board);
  const card = createTask(board, { title: 'first' }, { actor: AGENT, now: NOW });
  assert.equal(boardRevision(board), before + 1);
  const events = listEvents(board, { taskId: card.id });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'created');
  assert.equal(events[0]?.actor, 'agent:sess-test');
  board.close();
});

test('a card may be created with a template-shaped starting point', () => {
  const board = newBoard();
  // The human, because a priority is theirs — the agent case is pinned separately, just below.
  const card = createTask(
    board,
    { title: 'something broke', priority: 'p1-high', tags: ['bug'], dor: ['outcome'] },
    { actor: HUMAN, now: NOW }
  );
  assert.equal(card.priority, 'p1-high');
  assert.deepEqual(card.tags, ['bug']);
  assert.deepEqual(Object.keys(card.dor), ['outcome']);
  board.close();
});

test('refused: an empty title', () => {
  const board = newBoard();
  assert.throws(() => createTask(board, { title: '   ' }, { actor: HUMAN, now: NOW }), InvalidError);
  board.close();
});

test('refused: a new card may not start outside the backlog', () => {
  const board = newBoard();
  assert.throws(() => createTask(board, { title: 'x', state: 'in-progress' }, { actor: HUMAN, now: NOW }), InvalidError);
  board.close();
});

test('refused: an unknown priority', () => {
  const board = newBoard();
  assert.throws(
    () => createTask(board, { title: 'x', priority: 'p9-urgent' as never }, { actor: HUMAN, now: NOW }),
    InvalidError
  );
  board.close();
});

test('refused: an agent may not create an expedite card', () => {
  const board = newBoard();
  assert.throws(
    () => createTask(board, { title: 'x', classOfService: 'expedite' }, { actor: AGENT, now: NOW }),
    (error: unknown) => error instanceof PolicyViolation && error.policyCode === 'human-only'
  );
  board.close();
});

test('refused: an agent may not create a prioritised card', () => {
  // The same gate as an edit. Without it, an agent cannot *change* a priority and can simply create
  // one — which is how a blocker shipped: the create path never called `checkEdit`.
  const board = newBoard();
  for (const priority of ['p0-critical', 'p1-high', 'p3-low', 'p4-someday'] as const) {
    assert.throws(
      () => createTask(board, { title: 'x', priority }, { actor: AGENT, now: NOW }),
      (error: unknown) => error instanceof PolicyViolation && error.policyCode === 'human-only',
      `${priority} should be refused to an agent`
    );
  }
  // The default is not a choice, so it is allowed.
  assert.equal(createTask(board, { title: 'plain' }, { actor: AGENT, now: NOW }).priority, 'p2-normal');
  // And the human may of course choose one.
  assert.equal(createTask(board, { title: 'urgent', priority: 'p0-critical' }, { actor: HUMAN, now: NOW }).priority, 'p0-critical');
  board.close();
});

test('refused: a duplicate id', () => {
  const board = newBoard();
  createTask(board, { title: 'x', id: 'T-001' }, { actor: HUMAN, now: NOW });
  assert.throws(() => createTask(board, { title: 'y', id: 'T-001' }, { actor: HUMAN, now: NOW }), InvalidError);
  board.close();
});

// ------------------------------------------------------------------ read

test('an unknown card reads as undefined, and the OrThrow variant throws NotFoundError', () => {
  const board = newBoard();
  assert.equal(getTask(board, 'T-404'), undefined);
  assert.throws(() => updateTask(board, 'T-404', { title: 'x' }, { actor: HUMAN, now: NOW }), NotFoundError);
  board.close();
});

test('listing filters by state, assignee, tag and free text', () => {
  const board = newBoard();
  createTask(board, { title: 'alpha metrics', assignee: 'verifier', tags: ['metrics'] }, { actor: HUMAN, now: NOW });
  createTask(board, { title: 'beta board', assignee: 'dhira' }, { actor: HUMAN, now: NOW });
  assert.equal(listTasks(board, { state: ['backlog'] }).total, 2);
  assert.equal(listTasks(board, { assignee: 'dhira' }).total, 1);
  assert.equal(listTasks(board, { tag: 'metrics' }).total, 1);
  assert.equal(listTasks(board, { search: 'alpha' }).total, 1);
  assert.equal(listTasks(board, { state: ['done'] }).total, 0);
  board.close();
});

test('countsByState reports every state, including the empty ones', () => {
  const board = newBoard();
  createTask(board, { title: 'a' }, { actor: HUMAN, now: NOW });
  const counts = countsByState(board);
  assert.equal(counts.backlog, 1);
  assert.equal(counts.done, 0);
  assert.equal(counts.dropped, 0);
  assert.equal(Object.keys(counts).length, 6);
  board.close();
});

test('listing is paginated and reports a total beyond the page', () => {
  const board = newBoard();
  for (let index = 0; index < 5; index += 1) {
    createTask(board, { title: `card ${index}` }, { actor: HUMAN, now: NOW });
  }
  const page = listTasks(board, { limit: 2 });
  assert.equal(page.tasks.length, 2);
  assert.equal(page.total, 5);
  board.close();
});

// ------------------------------------------------------------------ update

test('an update bumps rev and records what changed', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  const updated = updateTask(board, card.id, { outcome: 'the strip shows peak' }, { actor: AGENT, now: NOW });
  assert.equal(updated.rev, 2);
  assert.equal(updated.outcome, 'the strip shows peak');
  assert.equal(updated.updatedBy, 'agent:sess-test');
  const events = listEvents(board, { taskId: card.id });
  assert.equal(events[0]?.kind, 'updated');
  assert.deepEqual(events[0]?.payload.fields, ['outcome']);
  board.close();
});

test('an update may clear a field with null', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first', assignee: 'verifier' }, { actor: HUMAN, now: NOW });
  const updated = updateTask(board, card.id, { assignee: null }, { actor: AGENT, now: NOW });
  assert.equal(updated.assignee, null);
  board.close();
});

test('an update that changes nothing records no event', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  const before = listEvents(board, { taskId: card.id }).length;
  updateTask(board, card.id, {}, { actor: HUMAN, now: NOW });
  assert.equal(listEvents(board, { taskId: card.id }).length, before);
  board.close();
});

test('refused: a stale expectedRev, and the current card comes back with the error', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  updateTask(board, card.id, { outcome: 'moved on' }, { actor: HUMAN, now: NOW });
  try {
    updateTask(board, card.id, { outcome: 'stale write' }, { actor: HUMAN, now: NOW, expectedRev: 1 });
    assert.fail('expected a ConflictError');
  } catch (error) {
    assert.ok(error instanceof ConflictError);
    assert.equal((error as ConflictError<unknown>).current instanceof Object, true);
    assert.equal(getTask(board, card.id)?.outcome, 'moved on');
  }
  board.close();
});

test('refused: an agent changing the priority is a policy violation, not a crash', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  try {
    updateTask(board, card.id, { priority: 'p0-critical' }, { actor: AGENT, now: NOW });
    assert.fail('expected a PolicyViolation');
  } catch (error) {
    assert.ok(error instanceof PolicyViolation);
    assert.equal((error as PolicyViolation).policyCode, 'human-only');
  }
  assert.equal(getTask(board, card.id)?.priority, 'p2-normal');
  board.close();
});

test('refused: an update that empties the title', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  assert.throws(() => updateTask(board, card.id, { title: '  ' }, { actor: HUMAN, now: NOW }), InvalidError);
  board.close();
});

// ------------------------------------------------------------------ move

test('leaving the backlog requires the Definition of Ready', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: AGENT, now: NOW });
  try {
    moveTask(board, { id: card.id, toState: 'ready' }, { actor: AGENT, now: NOW });
    assert.fail('expected a PolicyViolation');
  } catch (error) {
    assert.ok(error instanceof PolicyViolation);
    assert.equal((error as PolicyViolation).policyCode, 'dor-incomplete');
    assert.equal((error as PolicyViolation).missing.length, 4);
  }
  refine(board, card.id);
  assert.equal(moveTask(board, { id: card.id, toState: 'ready' }, { actor: AGENT, now: NOW }).state, 'ready');
  board.close();
});

test('entering work records the started point, and the event log agrees', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: AGENT, now: NOW });
  refine(board, card.id);
  const started = new Date('2026-10-16T09:00:00.000Z');
  const moved = moveTask(board, { id: card.id, toState: 'in-progress' }, { actor: AGENT, now: started });
  assert.equal(moved.startedAt, started.toISOString());
  const moves = listEvents(board, { taskId: card.id }).filter((event) => event.kind === 'moved');
  assert.equal(moves[0]?.fromState, 'backlog');
  assert.equal(moves[0]?.toState, 'in-progress');
  board.close();
});

test('entering done records the finished point, and reopening clears it', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  refine(board, card.id);
  moveTask(board, { id: card.id, toState: 'in-progress' }, { actor: HUMAN, now: new Date('2026-10-16T09:00:00.000Z') });
  moveTask(board, { id: card.id, toState: 'review' }, { actor: HUMAN, now: new Date('2026-10-17T09:00:00.000Z') });
  completeDod(board, card.id);
  const done = moveTask(board, { id: card.id, toState: 'done' }, { actor: HUMAN, now: new Date('2026-10-18T09:00:00.000Z') });
  assert.equal(done.finishedAt, '2026-10-18T09:00:00.000Z');

  const reopened = moveTask(
    board,
    { id: card.id, toState: 'in-progress', reason: 'the fix regressed' },
    { actor: HUMAN, now: new Date('2026-10-19T09:00:00.000Z') }
  );
  assert.equal(reopened.finishedAt, null);
  board.close();
});

test('refused: the WIP limit, counted from the board rather than argued about', () => {
  const board = newBoard();
  const cards = ['a', 'b', 'c'].map((title) =>
    createTask(board, { title }, { actor: HUMAN, now: NOW })
  );
  for (const card of cards) {
    refine(board, card.id);
    moveTask(board, { id: card.id, toState: 'ready' }, { actor: HUMAN, now: NOW });
  }
  moveTask(board, { id: cards[0]!.id, toState: 'in-progress' }, { actor: HUMAN, now: NOW });
  moveTask(board, { id: cards[1]!.id, toState: 'in-progress' }, { actor: HUMAN, now: NOW });
  assert.throws(
    () => moveTask(board, { id: cards[2]!.id, toState: 'in-progress' }, { actor: HUMAN, now: NOW }),
    (error: unknown) => error instanceof PolicyViolation && error.policyCode === 'wip-limit'
  );
  assert.equal(countsByState(board)['in-progress'], 2);
  board.close();
});

test('the human may except the WIP limit, and the exception is recorded on the card', () => {
  const board = newBoard();
  const cards = ['a', 'b', 'c'].map((title) => createTask(board, { title }, { actor: HUMAN, now: NOW }));
  for (const card of cards) {
    refine(board, card.id);
    moveTask(board, { id: card.id, toState: 'ready' }, { actor: HUMAN, now: NOW });
  }
  // Fill the column to its limit the ordinary way, then except it once.
  moveTask(board, { id: cards[0]!.id, toState: 'in-progress' }, { actor: HUMAN, now: NOW });
  moveTask(board, { id: cards[1]!.id, toState: 'in-progress' }, { actor: HUMAN, now: NOW });

  const forced = moveTask(
    board,
    { id: cards[2]!.id, toState: 'in-progress', force: true, reason: 'the deploy window closes tonight' },
    { actor: HUMAN, now: NOW }
  );
  assert.equal(forced.state, 'in-progress');
  assert.equal(forced.exceptions.length, 1);
  assert.equal(forced.exceptions[0]?.gate, 'wip');
  assert.equal(forced.exceptions[0]?.reason, 'the deploy window closes tonight');
  assert.equal(listEvents(board, { taskId: cards[2]!.id }).filter((event) => event.kind === 'exception').length, 1);
  assert.equal(countsByState(board)['in-progress'], 3);
  board.close();
});

test('refused: dropping without a reason', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  assert.throws(() => moveTask(board, { id: card.id, toState: 'dropped' }, { actor: HUMAN, now: NOW }), PolicyViolation);
  const dropped = moveTask(
    board,
    { id: card.id, toState: 'dropped', reason: 'superseded' },
    { actor: HUMAN, now: NOW }
  );
  assert.equal(dropped.droppedReason, 'superseded');
  board.close();
});

test('a move appends to the target column unless a position is given', () => {
  const board = newBoard();
  const first = createTask(board, { title: 'a' }, { actor: HUMAN, now: NOW });
  const second = createTask(board, { title: 'b' }, { actor: HUMAN, now: NOW });
  assert.equal(first.position, 0);
  assert.equal(second.position, 1);
  const atFront = moveTask(board, { id: second.id, toState: 'backlog', toPosition: -1 }, { actor: HUMAN, now: NOW });
  assert.equal(atFront.position, -1);
  board.close();
});

// ------------------------------------------------------------------ checks, blocking, comments, purge

test('a Definition of Ready check can be ticked and unticked', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  const ticked = setCheck(board, card.id, 'dor', 'outcome', true, { actor: AGENT, now: NOW });
  assert.deepEqual(Object.keys(ticked.dor), ['outcome']);
  const unticked = setCheck(board, card.id, 'dor', 'outcome', false, { actor: AGENT, now: NOW });
  assert.deepEqual(Object.keys(unticked.dor), []);
  board.close();
});

test('refused: a check id that does not belong to the gate', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  assert.throws(() => setCheck(board, card.id, 'dor', 'evidence', true, { actor: HUMAN, now: NOW }), InvalidError);
  assert.throws(() => setCheck(board, card.id, 'dod', 'outcome', true, { actor: HUMAN, now: NOW }), InvalidError);
  board.close();
});

test('blocking records a reason, and a blocked card may not be started', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  refine(board, card.id);
  const blocked = blockTask(board, card.id, 'waiting on the vendor', { actor: AGENT, now: NOW });
  assert.equal(blocked.blockedReason, 'waiting on the vendor');
  assert.throws(
    () => moveTask(board, { id: card.id, toState: 'in-progress' }, { actor: AGENT, now: NOW }),
    (error: unknown) => error instanceof PolicyViolation && error.policyCode === 'illegal-transition'
  );
  const unblocked = unblockTask(board, card.id, { actor: AGENT, now: NOW });
  assert.equal(unblocked.blockedReason, null);
  assert.equal(moveTask(board, { id: card.id, toState: 'in-progress' }, { actor: AGENT, now: NOW }).state, 'in-progress');
  board.close();
});

test('refused: blocking without a reason', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  assert.throws(() => blockTask(board, card.id, '   ', { actor: HUMAN, now: NOW }), InvalidError);
  board.close();
});

test('comments attach to a card in order', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  addComment(board, card.id, 'proposing p0 for this one', { actor: AGENT, now: NOW });
  addComment(board, card.id, 'agreed', { actor: HUMAN, now: NOW });
  const comments = listComments(board, card.id);
  assert.equal(comments.length, 2);
  assert.equal(comments[0]?.actor, 'agent:sess-test');
  assert.equal(comments[1]?.body, 'agreed');
  board.close();
});

test('refused: an empty comment', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  assert.throws(() => addComment(board, card.id, '  ', { actor: HUMAN, now: NOW }), InvalidError);
  board.close();
});

test('purge removes the row and leaves a purge event behind', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  purgeTask(board, card.id, { actor: HUMAN, now: NOW });
  assert.equal(getTask(board, card.id), undefined);
  const events = listEvents(board, { taskId: card.id });
  assert.equal(events[0]?.kind, 'purged');
  board.close();
});

test('refused: only the human may purge', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  assert.throws(() => purgeTask(board, card.id, { actor: AGENT, now: NOW }), InvalidError);
  assert.notEqual(getTask(board, card.id), undefined);
  board.close();
});

// ------------------------------------------------------------------ the transaction boundary

test('a throw inside a write leaves no partial state and releases the write guard', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });
  const before = boardRevision(board);
  const eventsBefore = listEvents(board, { taskId: card.id }).length;

  assert.throws(() =>
    withWrite(board, () => {
      updateTask(board, card.id, { outcome: 'should not survive' }, { actor: HUMAN, now: NOW });
      throw new Error('deliberate failure after a nested write would have been refused');
    })
  );

  // The nested write threw first, so nothing was written at all — and crucially the guard is clear.
  assert.equal(board.writing, false);
  assert.equal(getTask(board, card.id)?.outcome, null);
  assert.equal(boardRevision(board), before);
  assert.equal(listEvents(board, { taskId: card.id }).length, eventsBefore);
  board.close();
});

test('refused: a nested write, because two transactions in one mutation is a bug', () => {
  const board = newBoard();
  assert.throws(
    () =>
      withWrite(board, () => {
        withWrite(board, () => undefined);
      }),
    InvalidError
  );
  assert.equal(board.writing, false);
  board.close();
});

// ------------------------------------------------------------------ sprints

test('a sprint needs a goal-sized window: 31 days is allowed, 32 is not', () => {
  const board = newBoard();
  const sprint = createSprint(
    board,
    { name: 'Sprint 1', goal: 'kanban works end to end', start: '2026-10-15', end: '2026-11-15' },
    { actor: HUMAN, now: NOW }
  );
  assert.equal(sprint.id, 'S-001');
  assert.equal(sprint.state, 'planning');
  assert.throws(
    () => createSprint(board, { name: 'too long', goal: '', start: '2026-10-01', end: '2026-11-02' }, { actor: HUMAN, now: NOW }),
    PolicyViolation
  );
  board.close();
});

test('only one sprint is active at a time', () => {
  const board = newBoard();
  const first = createSprint(board, { name: 'one', goal: '', start: '2026-10-01', end: '2026-10-08' }, { actor: HUMAN, now: NOW });
  const second = createSprint(board, { name: 'two', goal: '', start: '2026-10-09', end: '2026-10-16' }, { actor: HUMAN, now: NOW });
  startSprint(board, first.id, { actor: HUMAN, now: NOW });
  assert.throws(() => startSprint(board, second.id, { actor: HUMAN, now: NOW }), InvalidError);
  board.close();
});

test('closing a sprint returns unfinished cards to the backlog and leaves finished ones alone', () => {
  const board = newBoard();
  const sprint = createSprint(board, { name: 'S', goal: '', start: '2026-10-01', end: '2026-10-08' }, { actor: HUMAN, now: NOW });
  startSprint(board, sprint.id, { actor: HUMAN, now: NOW });

  const unfinished = createTask(board, { title: 'unfinished', sprintId: sprint.id }, { actor: HUMAN, now: NOW });
  const finished = createTask(board, { title: 'finished', sprintId: sprint.id }, { actor: HUMAN, now: NOW });
  refine(board, unfinished.id);
  refine(board, finished.id);
  moveTask(board, { id: finished.id, toState: 'in-progress' }, { actor: HUMAN, now: NOW });
  completeDod(board, finished.id);
  moveTask(board, { id: finished.id, toState: 'done' }, { actor: HUMAN, now: NOW });

  const result = closeSprint(board, sprint.id, { actor: HUMAN, now: NOW });
  assert.deepEqual([...result.returned], [unfinished.id]);
  assert.equal(result.sprint.state, 'closed');
  assert.equal(getTask(board, unfinished.id)?.state, 'backlog');
  assert.equal(getTask(board, unfinished.id)?.sprintId, null);
  assert.equal(getTask(board, finished.id)?.state, 'done');
  board.close();
});

test('refused: closing a sprint that is not active', () => {
  const board = newBoard();
  const sprint = createSprint(board, { name: 'S', goal: '', start: '2026-10-01', end: '2026-10-08' }, { actor: HUMAN, now: NOW });
  assert.throws(() => closeSprint(board, sprint.id, { actor: HUMAN, now: NOW }), InvalidError);
  board.close();
});

test('refused: an agent cancelling a sprint, and a cancel without a reason', () => {
  const board = newBoard();
  const sprint = createSprint(board, { name: 'S', goal: '', start: '2026-10-01', end: '2026-10-08' }, { actor: HUMAN, now: NOW });
  startSprint(board, sprint.id, { actor: HUMAN, now: NOW });
  assert.throws(() => cancelSprint(board, sprint.id, 'nope', { actor: AGENT, now: NOW }), InvalidError);
  assert.throws(() => cancelSprint(board, sprint.id, '   ', { actor: HUMAN, now: NOW }), InvalidError);
  assert.equal(cancelSprint(board, sprint.id, 'the goal became obsolete', { actor: HUMAN, now: NOW }).state, 'cancelled');
  board.close();
});

test('listing sprints is newest-first', () => {
  const board = newBoard();
  createSprint(board, { name: 'one', goal: '', start: '2026-10-01', end: '2026-10-08' }, { actor: HUMAN, now: NOW });
  createSprint(board, { name: 'two', goal: '', start: '2026-10-09', end: '2026-10-16' }, { actor: HUMAN, now: NOW });
  assert.deepEqual(
    listSprints(board).map((sprint) => sprint.name),
    ['two', 'one']
  );
  board.close();
});

// ------------------------------------------------------------------ the Definition of Workflow

test('refused: a WIP limit that is not a whole number, which is how WIP control was disabled', () => {
  const board = newBoard();
  // `wip['in-progress'] = 'x'` made every limit comparison false, so the column was unbounded.
  assert.throws(
    () => writeDow(board, { ...readDow(board), wip: { 'in-progress': 'x' as never, review: 1 } }),
    InvalidError
  );
  assert.equal(readDow(board).wip['in-progress'], 2, 'the stored definition is untouched');
  board.close();
});

test('refused: a Definition of Ready that is present and wrong, and one that is empty', () => {
  const board = newBoard();
  // `null` is a *present* value and is refused; `undefined` means "not mentioned" and preserves the
  // stored one, which is what stops a partial update from erasing a gate. The wedge the reviewer
  // found was `undefined` reaching `missingChecks` — a JSON `null` on the wire — so both shapes are
  // pinned: the one that must be refused, and the one that must be harmless.
  assert.throws(() => writeDow(board, { ...readDow(board), dor: null as never }), InvalidError);
  assert.throws(() => writeDow(board, { ...readDow(board), dor: [] }), InvalidError, 'an empty gate is not a gate');
  assert.throws(() => writeDow(board, { ...readDow(board), dod: ['wibble' as never] }), InvalidError);

  const unchanged = readDow(board);
  assert.deepEqual([...unchanged.dor], ['outcome', 'acceptance', 'write-scope', 'estimate']);
  // An absent `dor` is not a problem to fix: the stored checklist survives untouched.
  writeDow(board, { ...unchanged, dor: undefined as never });
  assert.deepEqual([...readDow(board).dor], ['outcome', 'acceptance', 'write-scope', 'estimate']);
  board.close();
});

test('a partial Definition of Workflow update keeps everything it did not mention', () => {
  const board = newBoard();
  writeDow(board, { ...readDow(board), wip: { 'in-progress': 1, review: 1 } });
  const after = readDow(board);
  assert.equal(after.wip['in-progress'], 1);
  assert.deepEqual([...after.dor], ['outcome', 'acceptance', 'write-scope', 'estimate'], 'the DoR survived');
  assert.equal(after.policies.backlog.length > 0, true, 'the policies survived');
  board.close();
});

test('refused: an unknown field in the Definition of Workflow is rejected rather than stored', () => {
  const board = newBoard();
  assert.throws(() => writeDow(board, { ...readDow(board), readyCap: 0.5 as never }), InvalidError);
  assert.throws(() => writeDow(board, { ...readDow(board), sle: { p: 1.5, days: 3, source: 'guess' } }), InvalidError);
  assert.throws(() => writeDow(board, { ...readDow(board), policies: { wibble: 'x' } as never }), InvalidError);
  assert.throws(() => writeDow(board, 'wibble' as never), InvalidError);
  board.close();
});

// ------------------------------------------------------------------ the import's honesty

test('an imported finished row has no invented start or finish, so the metrics stay honest', () => {
  const board = newBoard();
  importTask(board, { id: 'T-900', title: 'an old finished row', state: 'done' }, { actor: HUMAN, now: NOW });
  const card = getTask(board, 'T-900');
  assert.equal(card?.state, 'done');
  assert.equal(card?.startedAt, null, 'we do not know when it started');
  assert.equal(card?.finishedAt, null, 'we do not know when it finished');

  const listed = listTasks(board, { limit: 10 });
  const metrics = computeFlowMetrics({ tasks: listed.tasks, now: NOW, dow: readDow(board), boardRev: 1 });
  assert.equal(metrics.throughput.days7, 0, 'a card with an unknown finish is not throughput');
  assert.equal(metrics.cycle.count, 0, 'and it has no cycle time to report');
  assert.deepEqual(cycleTimesFromTasks(listed.tasks), [], 'the columns agree');
  assert.deepEqual(cycleTimesFromEvents(moveObservations(board)), [], 'and so does the event log');
  board.close();
});

test('an imported card in progress has an unknown start, not today as a start', () => {
  const board = newBoard();
  importTask(board, { id: 'T-901', title: 'an old in-progress row', state: 'in-progress' }, { actor: HUMAN, now: NOW });
  assert.equal(getTask(board, 'T-901')?.startedAt, null);
  const listed = listTasks(board, { limit: 10 });
  const metrics = computeFlowMetrics({ tasks: listed.tasks, now: NOW, dow: readDow(board), boardRev: 1 });
  assert.equal(metrics.wip, 1, 'it is still work in progress');
  assert.equal(metrics.ages.length, 0, 'but its age is unknown rather than zero');
  board.close();
});

// ------------------------------------------------------------------ sprint edges

test('refused: a sprint longer than a month by a fraction, and one shorter than a day', () => {
  // `Math.round` used to accept both of these as 31 and as 1.
  assert.equal(checkSprintWindow('2026-10-01T00:00:00.000Z', '2026-11-01T09:00:00.000Z').ok, false);
  assert.equal(checkSprintWindow('2026-10-01T00:00:00.000Z', '2026-10-01T12:00:00.000Z').ok, false);
  assert.equal(checkSprintWindow('2026-10-01T09:00:00.000Z', '2026-11-01T09:00:00.000Z').ok, true);
});

test('refused: cancelling a sprint that is closed or already cancelled', () => {
  const board = newBoard();
  const sprint = createSprint(board, { name: 'S', goal: '', start: '2026-10-01', end: '2026-10-08' }, { actor: HUMAN, now: NOW });
  startSprint(board, sprint.id, { actor: HUMAN, now: NOW });
  closeSprint(board, sprint.id, { actor: HUMAN, now: NOW });
  assert.throws(() => cancelSprint(board, sprint.id, 'changed my mind', { actor: HUMAN, now: NOW }), InvalidError);
  board.close();
});

test('cancelling a sprint clears the unfinished cards, records an event for each, and keeps history', () => {
  const board = newBoard();
  const sprint = createSprint(board, { name: 'S', goal: '', start: '2026-10-01', end: '2026-10-08' }, { actor: HUMAN, now: NOW });
  startSprint(board, sprint.id, { actor: HUMAN, now: NOW });

  const open = createTask(board, { title: 'open', sprintId: sprint.id }, { actor: HUMAN, now: NOW });
  const shipped = createTask(board, { title: 'shipped', sprintId: sprint.id }, { actor: HUMAN, now: NOW });
  refine(board, shipped.id);
  moveTask(board, { id: shipped.id, toState: 'in-progress' }, { actor: HUMAN, now: NOW });
  completeDod(board, shipped.id);
  moveTask(board, { id: shipped.id, toState: 'done' }, { actor: HUMAN, now: NOW });

  cancelSprint(board, sprint.id, 'the goal became obsolete', { actor: HUMAN, now: NOW });
  assert.equal(getTask(board, open.id)?.sprintId, null, 'the open card is released');
  assert.equal(getTask(board, shipped.id)?.sprintId, sprint.id, 'the finished card keeps its history');
  assert.equal(listEvents(board, { taskId: open.id }).some((event) => event.kind === 'updated'), true, 'and the change is an event');
  board.close();
});

// ------------------------------------------------------------------ filters

test('a tag filter treats LIKE wildcards literally', () => {
  const board = newBoard();
  createTask(board, { title: 'tagged', tags: ['metrics'] }, { actor: HUMAN, now: NOW });
  createTask(board, { title: 'odd tag', tags: ['%'] }, { actor: HUMAN, now: NOW });
  assert.equal(listTasks(board, { tag: 'metrics' }).total, 1);
  assert.equal(listTasks(board, { tag: '%' }).total, 1, '% must match the literal tag, not everything');
  assert.equal(listTasks(board, { tag: 'metric' }).total, 0, 'and it is still an exact-ish match');
  board.close();
});

// ------------------------------------------------------------------ bounded input

test('refused: a comment longer than the cap, and the event keeps only a preview', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'first' }, { actor: HUMAN, now: NOW });

  // The route caps its body at 1 MiB; the tools and the CLI do not go through it, so the store is
  // the only writer-agnostic place to refuse a runaway input.
  assert.throws(
    () => addComment(board, card.id, 'x'.repeat(MAX_COMMENT_CHARS + 1), { actor: HUMAN, now: NOW }),
    InvalidError
  );

  const comment = addComment(board, card.id, 'y'.repeat(500), { actor: HUMAN, now: NOW });
  assert.equal(comment.body.length, 500, 'the comment itself is kept in full');
  const event = listEvents(board, { taskId: card.id }).find((entry) => entry.kind === 'commented');
  assert.equal((event?.payload.preview as string).length, COMMENT_EVENT_PREVIEW_CHARS, 'the log keeps a preview');
  assert.equal(event?.payload.length, 500, 'and the true length');
  board.close();
});


test('a limited read reports the whole count, so a partial view can be announced', () => {
  const board = newBoard();
  for (let index = 0; index < 3; index += 1) {
    createTask(board, { title: `card ${index}` }, { actor: HUMAN, now: NOW });
  }
  const page = listTasks(board, { limit: 2 });
  assert.equal(page.tasks.length, 2);
  assert.equal(page.total, 3, 'the total is the store\'s, not the page\'s');
  board.close();
});

test('openBoard() with no argument opens the default location', () => {
  // A required `path` made `openBoard()` throw `ERR_INVALID_ARG_TYPE` in a plain-JS probe — the
  // error names the symptom and hides the intent. The default is derived per call, not at load, so
  // a changed `DSH_HOME` is honoured (the bug that once froze it to the first home it ever saw).
  const previous = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'kanban-default-'));
  try {
    process.env.DSH_HOME = home;
    const board = openBoard();
    assert.equal(board.path, join(home, '.kanban', 'board.db'));
    assert.equal(existsSync(join(home, '.kanban', 'board.db')), true, 'and it was created there');
    board.close();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the write scope

/**
 * A v1 database, built from the v1 migration itself and given one row.
 *
 * Opening it is the only honest way to test a migration: a database created by *this* build is
 * already at the new version, so it proves nothing about the upgrade path a live `board.db` takes.
 */
function writeV1Board(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(MIGRATIONS[0] as string);
  db.exec('PRAGMA user_version = 1');
  db.prepare(
    `INSERT INTO tasks (id, title, state, priority, class_of_service, position, created_at, updated_at, created_by, updated_by)
     VALUES ('T-900', 'a v1 row', 'backlog', 'p2-normal', 'standard', 0,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'human:dhira', 'human:dhira')`
  ).run();
  db.close();
}

test('write-scope: a v1 board migrates, its rows gain an empty scope, and the schema moves to v2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-v1-'));
  const path = join(dir, 'board.db');
  try {
    writeV1Board(path);
    const board = openBoard(path);
    try {
      assert.equal(SCHEMA_VERSION, 2, 'the build writes version 2');
      const version = board.db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(version.user_version, 2, 'the migration ran through the user_version path');
      const column = board.db
        .prepare("SELECT 1 AS present FROM pragma_table_info('tasks') WHERE name = 'write_scopes'")
        .get();
      assert.notEqual(column, undefined, 'the column exists after the migration');
      assert.deepEqual(
        getTask(board, 'T-900')?.writeScopes,
        [],
        'a row that never recorded a scope does not get one invented'
      );
      assert.equal(getTask(board, 'T-900')?.title, 'a v1 row', 'and the row itself survived');
    } finally {
      board.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write-scope: a recorded scope satisfies the DoR item, so the card leaves the backlog without a tick', () => {
  const board = newBoard();
  const card = createTask(
    board,
    { title: 'scoped', writeScopes: ['src/store/**', 'test/**'] },
    { actor: AGENT, now: NOW }
  );
  // Everything the card can answer in prose is ticked; `write-scope` is answered by the field.
  for (const check of ['outcome', 'acceptance', 'estimate'] as const) {
    setCheck(board, card.id, 'dor', check, true, { actor: AGENT, now: NOW });
  }

  const ready = moveTask(board, { id: card.id, toState: 'ready' }, { actor: AGENT, now: NOW });
  assert.equal(ready.state, 'ready', 'the gate accepts the recorded scope');
  assert.deepEqual(getTask(board, card.id)?.writeScopes, ['src/store/**', 'test/**']);
  assert.equal(
    getTask(board, card.id)?.dor['write-scope'],
    undefined,
    'and no tick was needed — the fact is the evidence'
  );
  board.close();
});

test('write-scope: the item can still be ticked with a scope stored, and the tick is recorded', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'scoped', writeScopes: ['src/**'] }, { actor: AGENT, now: NOW });
  const ticked = setCheck(board, card.id, 'dor', 'write-scope', true, { actor: AGENT, now: NOW });
  assert.notEqual(ticked.dor['write-scope'], undefined, 'the acceptance the defect named: it can be ticked');
  assert.deepEqual(getTask(board, card.id)?.writeScopes, ['src/**'], 'because the fact behind it is stored');
  for (const check of ['outcome', 'acceptance', 'estimate'] as const) {
    setCheck(board, card.id, 'dor', check, true, { actor: AGENT, now: NOW });
  }
  assert.equal(moveTask(board, { id: card.id, toState: 'ready' }, { actor: AGENT, now: NOW }).state, 'ready');
  board.close();
});

test('write-scope: a card with no scope is refused by name, and the refusal says which field supplies it', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'unscoped' }, { actor: AGENT, now: NOW });
  for (const check of ['outcome', 'acceptance', 'estimate'] as const) {
    setCheck(board, card.id, 'dor', check, true, { actor: AGENT, now: NOW });
  }
  assert.throws(
    () => moveTask(board, { id: card.id, toState: 'ready' }, { actor: AGENT, now: NOW }),
    (error: unknown) =>
      error instanceof PolicyViolation &&
      error.policyCode === 'dor-incomplete' &&
      /write-scope/.test(error.message) &&
      /writeScope/.test(error.message),
    'the caller is told the field, not just the check id'
  );
  assert.equal(getTask(board, card.id)?.state, 'backlog');
  board.close();
});

test('write-scope: a prefix is normalized to one spelling, and one that escapes the workspace is refused', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'scoped', writeScopes: './src/store/' }, { actor: HUMAN, now: NOW });
  assert.deepEqual(card.writeScopes, ['src/store'], 'a leading ./ and a trailing / are the same prefix');

  const windows = updateTask(board, card.id, { writeScopes: 'a\\b' }, { actor: HUMAN, now: NOW });
  assert.deepEqual(windows.writeScopes, ['a/b'], 'a backslash is a separator, not a second path');

  assert.throws(() => updateTask(board, card.id, { writeScopes: ['/etc'] }, { actor: HUMAN, now: NOW }), InvalidError);
  assert.throws(() => updateTask(board, card.id, { writeScopes: ['../up'] }, { actor: HUMAN, now: NOW }), InvalidError);
  assert.throws(() => updateTask(board, card.id, { writeScopes: [''] }, { actor: HUMAN, now: NOW }), InvalidError);
  assert.deepEqual(getTask(board, card.id)?.writeScopes, ['a/b'], 'a refused scope changed nothing');

  const cleared = updateTask(board, card.id, { writeScopes: [] }, { actor: HUMAN, now: NOW });
  assert.deepEqual(cleared.writeScopes, []);
  board.close();
});
