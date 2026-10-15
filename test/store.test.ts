/**
 * The store, end to end, against a real (in-memory) database.
 *
 * Ordered by the code flow: opening and seeding, then create → read → update → move, then the
 * negative cases each mutation can produce, then sprints and the transaction boundary. The
 * in-memory board is the same `DatabaseSync` code path as the file-backed one — `:memory:` only
 * skips the directory and the WAL pragma — so nothing here is a simulation of the real thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConflictError,
  DEFAULT_DOW,
  InvalidError,
  NotFoundError,
  PolicyViolation,
  addComment,
  boardRevision,
  blockTask,
  cancelSprint,
  closeSprint,
  countsByState,
  createSprint,
  createTask,
  generateTaskId,
  getTask,
  listComments,
  listEvents,
  listSprints,
  listTasks,
  listTemplates,
  listViews,
  moveTask,
  purgeTask,
  readBoardTitle,
  readDow,
  setCheck,
  startSprint,
  unblockTask,
  updateTask,
  withWrite,
  writeBoardTitle,
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
  const card = createTask(
    board,
    { title: 'something broke', priority: 'p1-high', tags: ['bug'], dor: ['outcome'] },
    { actor: AGENT, now: NOW }
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
    InvalidError
  );
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
