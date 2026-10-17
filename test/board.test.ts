/**
 * The browser half's model and drag logic, without a DOM.
 *
 * Ordered by the code flow: what a payload looks like as columns, then the filters, then the write
 * path (a local verdict, the optimistic projection), then the drag arithmetic, then the negative
 * cases. Everything here is a pure function of data, which is why a drag-and-drop board can be
 * pinned at all — jsdom's drag events are too unreliable to carry the logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageBand,
  ageDays,
  applyLocalMove,
  checkMoveLocally,
  columnsOf,
  filterCards,
  formatAge,
  limitFor,
  missingChecks,
  moveTargets,
  positionForIndex,
  priorityBadge,
  wipTotal,
  type BoardPayload,
  type ViewFilter,
} from '../lib/v1/client/model.js';
import { beginDrag, dragOver, dropTarget, indexFromPointer, isDropAllowed, keyboardTarget } from '../lib/v1/client/dnd.js';
import type { Task } from '../lib/v1/store/index.js';

/** A payload with the same shape the host sends. */
function payload(tasks: Task[], overrides: Partial<BoardPayload> = {}): BoardPayload {
  const base: BoardPayload = {
    rev: 7,
    title: 'Board',
    dow: {
      wip: { 'in-progress': 2, review: 1 },
      readyCap: 5,
      sle: { p: 0.85, days: 3, source: 'guess' },
      policies: { backlog: '', ready: '', 'in-progress': '', review: '', done: '', dropped: '' },
      dor: ['outcome', 'acceptance', 'write-scope', 'estimate'],
      dod: ['evidence', 'tests-or-na', 'docs-or-lesson', 'links-resolve', 'no-unverified-claims'],
    },
    tasks,
    metrics: {
      generatedAt: '2026-10-15T12:00:00.000Z',
      boardRev: 7,
      wip: 0,
      wipByState: {},
      countsByState: {},
      throughput: { days7: 0, days30: 0 },
      ages: [],
      cycle: { count: 0, medianDays: null, p85Days: null, meanDays: null, minDays: null, maxDays: null },
      sle: { p: 0.85, days: 3, source: 'guess', basis: 0 },
      ageing: { count: 0, oldestDays: null },
    },
    counts: {},
    views: [],
    templates: [],
    sprints: [],
    invalid: [],
    truncated: null,
    total: tasks.length,
    servedAt: '2026-10-15T12:00:00.000Z',
    buildId: 'test',
  };
  return { ...base, ...overrides };
}

function card(id: string, state: Task['state'], extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `card ${id}`,
    outcome: null,
    description: null,
    acceptance: null,
    state,
    priority: 'p2-normal',
    classOfService: 'standard',
    blockedReason: null,
    droppedReason: null,
    assignee: null,
    project: null,
    workspace: null,
    sprintId: null,
    estimate: null,
    due: null,
    tags: [],
    links: [],
    writeScopes: [],
    folder: null,
    parentId: null,
    position: 0,
    rev: 1,
    dor: {},
    dod: {},
    exceptions: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    createdBy: 'human:dhira',
    updatedBy: 'human:dhira',
    ...extra,
  };
}

const REFINED = Object.fromEntries(['outcome', 'acceptance', 'write-scope', 'estimate'].map((id) => [id, { at: 'x', by: 'y' }]));

// ------------------------------------------------------------------ the columns

test('the board draws every lane, dropped last', () => {
  // No filter removes a lane: the panel has no view row and no state picker, so the drawn columns
  // are the state list itself, in store order, with the one state a card leaves the board for at the
  // end. That lane is what keeps a dropped card reachable.
  const columns = columnsOf(payload([]));
  assert.deepEqual(
    columns.map((column) => column.state),
    ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped']
  );
  const named = columnsOf(payload([]), { state: ['dropped'] });
  assert.deepEqual(
    named.map((column) => column.state),
    ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped'],
    'a filter narrows cards, never lanes'
  );
});

test('cards land in their own lane, ordered by position then priority', () => {
  const columns = columnsOf(
    payload([
      card('T-003', 'in-progress', { position: 2 }),
      card('T-001', 'in-progress', { position: 0 }),
      card('T-002', 'in-progress', { position: 1 }),
      card('T-009', 'backlog'),
    ])
  );
  const inProgress = columns.find((column) => column.state === 'in-progress');
  assert.deepEqual(inProgress?.cards.map((entry) => entry.id), ['T-001', 'T-002', 'T-003']);
  assert.deepEqual(columns.find((column) => column.state === 'backlog')?.cards.map((entry) => entry.id), ['T-009']);
});

test('an expedite card leads its lane whatever its position', () => {
  const columns = columnsOf(
    payload([
      card('T-001', 'in-progress', { position: 0 }),
      card('T-002', 'in-progress', { position: 9, classOfService: 'expedite', priority: 'p4-someday' }),
    ])
  );
  assert.deepEqual(columns.find((column) => column.state === 'in-progress')?.cards.map((entry) => entry.id), ['T-002', 'T-001']);
});

test('a lane over its limit says so, and one at the limit does not', () => {
  const atLimit = columnsOf(payload([card('T-001', 'in-progress'), card('T-002', 'in-progress')]));
  assert.equal(atLimit.find((column) => column.state === 'in-progress')?.over, false);

  const over = columnsOf(payload([card('T-001', 'in-progress'), card('T-002', 'in-progress'), card('T-003', 'in-progress')]));
  assert.equal(over.find((column) => column.state === 'in-progress')?.over, true);
});

test('limitFor names the WIP limits, the ready cap, and nothing else', () => {
  const dow = payload([]).dow;
  assert.equal(limitFor('in-progress', dow), 2);
  assert.equal(limitFor('review', dow), 1);
  assert.equal(limitFor('ready', dow), 5);
  assert.equal(limitFor('backlog', dow), undefined);
  assert.equal(limitFor('done', dow), undefined);
});

test('WIP counts only the started, unfinished lanes', () => {
  assert.equal(
    wipTotal([card('T-001', 'backlog'), card('T-002', 'in-progress'), card('T-003', 'review'), card('T-004', 'done')]),
    2
  );
});

// ------------------------------------------------------------------ filters

interface FilterCase {
  readonly name: string;
  readonly filter: ViewFilter;
  readonly expected: readonly string[];
}

const CARDS: Task[] = [
  card('T-001', 'backlog', { title: 'metrics strip', tags: ['metrics'], assignee: 'verifier', project: 'dsh' }),
  card('T-002', 'backlog', { title: 'board lanes', tags: ['ui'] }),
  card('T-003', 'in-progress', { title: 'blocked thing', blockedReason: 'vendor', sprintId: 'S-001' }),
  card('T-004', 'ready', { priority: 'p0-critical' }),
];

const filterCases: readonly FilterCase[] = [
  { name: 'by state', filter: { state: ['backlog'] }, expected: ['T-001', 'T-002'] },
  { name: 'by assignee', filter: { assignee: 'verifier' }, expected: ['T-001'] },
  { name: 'by tag', filter: { tag: 'ui' }, expected: ['T-002'] },
  { name: 'by project', filter: { project: 'dsh' }, expected: ['T-001'] },
  { name: 'by sprint', filter: { sprintId: 'S-001' }, expected: ['T-003'] },
  { name: 'by priority', filter: { priority: ['p0-critical'] }, expected: ['T-004'] },
  { name: 'blocked only', filter: { blocked: true }, expected: ['T-003'] },
  { name: 'free text over the title', filter: { search: 'lanes' }, expected: ['T-002'] },
  { name: 'free text over the id', filter: { search: 't-003' }, expected: ['T-003'] },
  { name: 'nothing matches', filter: { search: 'wibble' }, expected: [] },
  { name: 'an empty filter keeps everything', filter: {}, expected: ['T-001', 'T-002', 'T-003', 'T-004'] },
];

for (const testCase of filterCases) {
  test(`filter: ${testCase.name}`, () => {
    assert.deepEqual(
      filterCards(CARDS, testCase.filter).map((entry) => entry.id),
      testCase.expected
    );
  });
}

// ------------------------------------------------------------------ the local verdict

test('a refined card may leave the backlog locally', () => {
  const board = payload([card('T-001', 'backlog', { dor: REFINED })]);
  const verdict = checkMoveLocally({ payload: board, task: board.tasks[0] as Task, toState: 'ready' });
  assert.deepEqual(verdict, { ok: true });
});

test('an unrefined card may not, and the missing checks come back with the refusal', () => {
  const board = payload([card('T-001', 'backlog')]);
  const verdict = checkMoveLocally({ payload: board, task: board.tasks[0] as Task, toState: 'ready' });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.deepEqual(verdict.missing, ['outcome', 'acceptance', 'write-scope', 'estimate']);
    assert.match(verdict.reason, /Definition of Ready/);
  }
});

test('an unrefined card may still be dropped without refinement', () => {
  const board = payload([card('T-001', 'backlog')]);
  const verdict = checkMoveLocally({
    payload: board,
    task: board.tasks[0] as Task,
    toState: 'dropped',
    reason: 'not doing this',
  });
  assert.deepEqual(verdict, { ok: true });
});

test('entering done needs its Definition of Done', () => {
  const board = payload([card('T-001', 'review')]);
  const verdict = checkMoveLocally({ payload: board, task: board.tasks[0] as Task, toState: 'done' });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /Definition of Done/);
});

test('refused: the WIP limit, counted from the payload', () => {
  const board = payload([card('T-001', 'in-progress'), card('T-002', 'in-progress'), card('T-003', 'ready', { dor: REFINED })]);
  const verdict = checkMoveLocally({ payload: board, task: board.tasks[2] as Task, toState: 'in-progress' });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /limit is 2 and it is full/);
});

test('an expedite card is not stopped by the WIP limit', () => {
  const board = payload([
    card('T-001', 'in-progress'),
    card('T-002', 'in-progress'),
    card('T-003', 'ready', { dor: REFINED, classOfService: 'expedite' }),
  ]);
  assert.deepEqual(checkMoveLocally({ payload: board, task: board.tasks[2] as Task, toState: 'in-progress' }), { ok: true });
});

test('refused: a blocked card may not be pulled into work', () => {
  const board = payload([card('T-001', 'ready', { dor: REFINED, blockedReason: 'vendor' })]);
  const verdict = checkMoveLocally({ payload: board, task: board.tasks[0] as Task, toState: 'in-progress' });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /blocked/);
});

test('refused: dropping and reopening both need a reason', () => {
  const backlog = payload([card('T-001', 'backlog')]);
  const drop = checkMoveLocally({ payload: backlog, task: backlog.tasks[0] as Task, toState: 'dropped' });
  assert.equal(drop.ok, false);

  const done = payload([card('T-001', 'done', { startedAt: 'x', finishedAt: 'y' })]);
  const reopen = checkMoveLocally({ payload: done, task: done.tasks[0] as Task, toState: 'in-progress' });
  assert.equal(reopen.ok, false);
  if (!reopen.ok) assert.match(reopen.reason, /reopening/);
});

test('an exception needs a reason before it is allowed', () => {
  const board = payload([card('T-001', 'backlog')]);
  const without = checkMoveLocally({ payload: board, task: board.tasks[0] as Task, toState: 'ready', force: true });
  assert.equal(without.ok, false);
  const with_ = checkMoveLocally({
    payload: board,
    task: board.tasks[0] as Task,
    toState: 'ready',
    force: true,
    reason: 'the deploy window closes tonight',
  });
  assert.deepEqual(with_, { ok: true });
});

test('missingChecks reports only the unticked ones', () => {
  const board = payload([card('T-001', 'backlog', { dor: { outcome: { at: 'x', by: 'y' } } })]);
  assert.deepEqual(missingChecks(board.tasks[0] as Task, board.dow, 'dor'), ['acceptance', 'write-scope', 'estimate']);
  assert.equal(missingChecks(board.tasks[0] as Task, board.dow, 'dod').length, 5);
});

// ------------------------------------------------------------------ the optimistic projection

test('a local move writes the started point and recomputes the counts', () => {
  const board = payload([card('T-001', 'ready', { dor: REFINED })]);
  const moved = applyLocalMove(board, 'T-001', 'in-progress', 0, '2026-10-15T12:00:00.000Z');
  const task = moved.tasks[0] as Task;
  assert.equal(task.state, 'in-progress');
  assert.equal(task.startedAt, '2026-10-15T12:00:00.000Z');
  assert.equal(task.rev, 2);
  assert.equal(moved.counts['in-progress'], 1);
  assert.equal(moved.counts.ready, 0);
});

test('a local move to done writes the finished point, and one away from done clears it', () => {
  const board = payload([card('T-001', 'review', { startedAt: '2026-10-01T00:00:00.000Z' })]);
  const done = applyLocalMove(board, 'T-001', 'done', 0, '2026-10-15T12:00:00.000Z');
  assert.equal((done.tasks[0] as Task).finishedAt, '2026-10-15T12:00:00.000Z');

  const back = applyLocalMove(done, 'T-001', 'review', 0, '2026-10-16T12:00:00.000Z');
  assert.equal((back.tasks[0] as Task).finishedAt, null);
});

test('a local move leaves every other card alone', () => {
  const board = payload([card('T-001', 'ready'), card('T-002', 'backlog')]);
  const moved = applyLocalMove(board, 'T-001', 'in-progress', 0, '2026-10-15T12:00:00.000Z');
  assert.equal((moved.tasks[1] as Task).state, 'backlog');
});

// ------------------------------------------------------------------ drag arithmetic

test('a drop between two cards takes the midpoint, so no other row moves', () => {
  const cards = [card('T-001', 'backlog', { position: 0 }), card('T-002', 'backlog', { position: 10 })];
  assert.equal(positionForIndex(cards, 1), 5);
});

test('a drop at the top goes before the first card, and at the end past the last', () => {
  const cards = [card('T-001', 'backlog', { position: 0 }), card('T-002', 'backlog', { position: 10 })];
  assert.equal(positionForIndex(cards, 0), -1);
  assert.equal(positionForIndex(cards, 2), 11);
});

test('a drop into an empty lane starts at zero', () => {
  assert.equal(positionForIndex([], 0), 0);
});

test('the drop index comes from the pointer against card midpoints', () => {
  const cards = [card('T-001', 'backlog'), card('T-002', 'backlog'), card('T-003', 'backlog')];
  const midpoints = [10, 30, 50];
  assert.equal(indexFromPointer(cards, 'T-004', 5, midpoints), 0);
  assert.equal(indexFromPointer(cards, 'T-004', 20, midpoints), 1);
  assert.equal(indexFromPointer(cards, 'T-004', 40, midpoints), 2);
  assert.equal(indexFromPointer(cards, 'T-004', 90, midpoints), 3);
});

test('a card being dragged is not measured against itself', () => {
  const cards = [card('T-001', 'backlog'), card('T-002', 'backlog')];
  // The pointer is below T-001's midpoint but T-001 is the card moving, so only T-002 counts.
  assert.equal(indexFromPointer(cards, 'T-001', 25, [10, 30]), 0);
});

test('the drag state carries the target lane and index to the drop', () => {
  const started = beginDrag('T-001', 'backlog');
  assert.equal(started.taskId, 'T-001');
  const over = dragOver(started, 'review', 2);
  assert.deepEqual(dropTarget(over), { taskId: 'T-001', toState: 'review', index: 2 });
});

test('an identical dragover keeps the same state object, so nothing re-renders', () => {
  const started = dragOver(beginDrag('T-001', 'backlog'), 'review', 1);
  assert.equal(dragOver(started, 'review', 1), started);
});

test('with nothing being dragged, a drop does nothing', () => {
  assert.equal(dropTarget(null), null);
});

test('the keyboard moves one column along the board order and stops at the edges', () => {
  assert.equal(keyboardTarget('backlog', 'right'), 'ready');
  assert.equal(keyboardTarget('in-progress', 'left'), 'ready');
  assert.equal(keyboardTarget('done', 'right'), 'dropped', 'done is no longer the last lane');
  assert.equal(keyboardTarget('dropped', 'right'), null, 'dropped is the end of the board order');
  assert.equal(keyboardTarget('dropped', 'left'), 'done', 'and Alt+← walks back out of it');
  assert.equal(keyboardTarget('backlog', 'left'), null);
});

test('every lane is a legal drop target, because the gate explains the refusal', () => {
  assert.equal(isDropAllowed('backlog', 'done'), true);
  assert.equal(isDropAllowed('done', 'backlog'), true);
});

test('moveTargets offers every other state', () => {
  assert.deepEqual(moveTargets('ready'), ['backlog', 'in-progress', 'review', 'done', 'dropped']);
});

// ------------------------------------------------------------------ display helpers

test('age is measured from the started point, and is null before it', () => {
  assert.equal(ageDays(card('T-001', 'backlog'), '2026-10-15T12:00:00.000Z'), null);
  assert.equal(
    ageDays(card('T-001', 'in-progress', { startedAt: '2026-10-13T12:00:00.000Z' }), '2026-10-15T12:00:00.000Z'),
    2
  );
});

test('the age band follows the SLE, with a stale band past 1.5x', () => {
  assert.equal(ageBand(null, 3), 'fresh');
  assert.equal(ageBand(1, 3), 'fresh');
  assert.equal(ageBand(4, 3), 'ageing');
  assert.equal(ageBand(5, 3), 'stale');
});

test('age formatting is locale-free and drops the decimal on whole days', () => {
  assert.equal(formatAge(null), '—');
  assert.equal(formatAge(2), '2d');
  assert.equal(formatAge(2.5), '2.5d');
});

test('the priority badge is short and stable', () => {
  assert.equal(priorityBadge('p0-critical'), 'P0');
  assert.equal(priorityBadge('p4-someday'), 'P4');
});

// ------------------------------------------------------------------ the write scope

/** Every DoR item except `write-scope`, which the recorded scope is meant to answer. */
const REFINED_EXCEPT_SCOPE = Object.fromEntries(
  ['outcome', 'acceptance', 'estimate'].map((id) => [id, { at: 'x', by: 'y' }])
);

test('write-scope: a recorded scope satisfies the local DoR gate, so the panel does not refuse what the host allows', () => {
  const scoped = payload([
    card('T-001', 'backlog', { dor: REFINED_EXCEPT_SCOPE, writeScopes: ['src/store/**'] }),
  ]);
  assert.deepEqual(
    checkMoveLocally({ payload: scoped, task: scoped.tasks[0] as Task, toState: 'ready' }),
    { ok: true }
  );
  assert.deepEqual(missingChecks(scoped.tasks[0] as Task, scoped.dow, 'dor'), []);
});

test('write-scope: with no scope the local refusal names the field that supplies it', () => {
  const unscoped = payload([card('T-001', 'backlog', { dor: REFINED_EXCEPT_SCOPE })]);
  const verdict = checkMoveLocally({ payload: unscoped, task: unscoped.tasks[0] as Task, toState: 'ready' });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.deepEqual(verdict.missing, ['write-scope']);
    assert.match(verdict.reason, /writeScope/);
  }
});
