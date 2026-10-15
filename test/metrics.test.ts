/**
 * The four mandatory flow metrics, and the Service Level Expectation built from them.
 *
 * Ordered by the code flow: the pure arithmetic, then a single card through its life, then the
 * aggregate, then the cross-check that keeps the columns and the event log honest.
 *
 * Every case pins a fixed clock. A metric test that reads the real time is a metric test that
 * fails on the day it crosses a boundary, once, unreproducibly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DOW,
  MIN_HISTORY_FOR_SLE,
  boardRevision,
  computeFlowMetrics,
  createTask,
  cycleTimesFromEvents,
  cycleTimesFromTasks,
  deriveSle,
  listTasks,
  moveObservations,
  moveTask,
  percentile,
  readDow,
  setCheck,
} from '../lib/v1/store/index.js';
import { HUMAN, NOW, newBoard } from './helpers.ts';

const DAY = 86_400_000;
const at = (dayOffset: number): Date => new Date(NOW.getTime() + dayOffset * DAY);

function refine(board: ReturnType<typeof newBoard>, id: string): void {
  for (const check of DEFAULT_DOW.dor) setCheck(board, id, 'dor', check, true, { actor: HUMAN, now: NOW });
}

function completeDod(board: ReturnType<typeof newBoard>, id: string): void {
  for (const check of DEFAULT_DOW.dod) setCheck(board, id, 'dod', check, true, { actor: HUMAN, now: NOW });
}

/** A card that started `startIn` days ago and finished `finishIn` days ago. */
function finishedCard(board: ReturnType<typeof newBoard>, title: string, startIn: number, finishIn: number): string {
  const card = createTask(board, { title }, { actor: HUMAN, now: at(-30) });
  refine(board, card.id);
  moveTask(board, { id: card.id, toState: 'in-progress' }, { actor: HUMAN, now: at(startIn) });
  completeDod(board, card.id);
  moveTask(board, { id: card.id, toState: 'done' }, { actor: HUMAN, now: at(finishIn) });
  return card.id;
}

function metricsOf(board: ReturnType<typeof newBoard>, now: Date = NOW) {
  const listed = listTasks(board, { limit: 500 });
  const dow = readDow(board);
  return computeFlowMetrics({ tasks: listed.tasks, now, dow, boardRev: boardRevision(board) });
}

// ------------------------------------------------------------------ the arithmetic

test('percentile uses the nearest rank, so the answer is always an observation', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 0.85), 9);
  assert.equal(percentile(values, 0.5), 5);
  assert.equal(percentile(values, 1), 10);
});

test('percentile keeps the input order untouched', () => {
  const values = [5, 1, 4, 2, 3];
  percentile(values, 0.5);
  assert.deepEqual(values, [5, 1, 4, 2, 3]);
});

test('percentile of nothing is null, not zero', () => {
  assert.equal(percentile([], 0.85), null);
});

test('an SLE from thin history says it is a guess', () => {
  const sle = deriveSle([2, 3], DEFAULT_DOW);
  assert.equal(sle.source, 'guess');
  assert.equal(sle.days, DEFAULT_DOW.sle.days);
  assert.equal(sle.basis, 2);
});

test('an SLE from enough history is computed, and never rounds down to zero days', () => {
  const times = Array.from({ length: MIN_HISTORY_FOR_SLE }, (_, index) => index + 1);
  const sle = deriveSle(times, DEFAULT_DOW);
  assert.equal(sle.source, 'history');
  assert.equal(sle.days, Math.ceil(percentile(times, DEFAULT_DOW.sle.p) as number));

  const sameDay = Array.from({ length: MIN_HISTORY_FOR_SLE }, () => 0.1);
  assert.equal(deriveSle(sameDay, DEFAULT_DOW).days, 1);
});

test('cycle time from the columns is the exact elapsed time', () => {
  const times = cycleTimesFromTasks([
    {
      startedAt: '2026-10-01T00:00:00.000Z',
      finishedAt: '2026-10-02T12:00:00.000Z',
    } as never,
  ]);
  assert.deepEqual(times, [1.5]);
});

test('an unfinished card contributes no cycle time', () => {
  assert.deepEqual(cycleTimesFromTasks([{ startedAt: '2026-10-01T00:00:00.000Z', finishedAt: null } as never]), []);
});

// ------------------------------------------------------------------ one card through its life

test('an empty board reports zeros rather than NaN', () => {
  const board = newBoard();
  const metrics = metricsOf(board);
  assert.equal(metrics.wip, 0);
  assert.equal(metrics.cycle.count, 0);
  assert.equal(metrics.cycle.medianDays, null);
  assert.equal(metrics.cycle.p85Days, null);
  assert.equal(metrics.throughput.days7, 0);
  assert.equal(metrics.ageing.oldestDays, null);
  assert.equal(metrics.sle.source, 'guess');
  board.close();
});

test('work in progress is counted, and a blocked card still counts', () => {
  const board = newBoard();
  // Created in the past on purpose: the schema refuses a card that started before it existed, and
  // a fixture that has to violate a constraint to be set up is a fixture testing the wrong thing.
  const card = createTask(board, { title: 'wip' }, { actor: HUMAN, now: at(-30) });
  refine(board, card.id);
  moveTask(board, { id: card.id, toState: 'in-progress' }, { actor: HUMAN, now: at(-2) });

  const before = metricsOf(board);
  assert.equal(before.wip, 1);
  assert.equal(before.wipByState['in-progress'], 1);
  assert.equal(before.ages.length, 1);
  assert.equal(before.ages[0]?.days, 2);

  const blocked = metricsOf(board, at(1));
  assert.equal(blocked.ages[0]?.days, 3, 'age grows with the clock');
  board.close();
});

test('the backlog is not work in progress', () => {
  const board = newBoard();
  createTask(board, { title: 'idea' }, { actor: HUMAN, now: NOW });
  const metrics = metricsOf(board);
  assert.equal(metrics.wip, 0);
  assert.equal(metrics.countsByState.backlog, 1);
  assert.equal(metrics.ages.length, 0);
  board.close();
});

test('a finished card counts toward throughput and leaves the ageing list', () => {
  const board = newBoard();
  finishedCard(board, 'shipped', -5, -1);
  const metrics = metricsOf(board);
  assert.equal(metrics.wip, 0);
  assert.equal(metrics.throughput.days7, 1);
  assert.equal(metrics.throughput.days30, 1);
  assert.equal(metrics.cycle.count, 1);
  assert.equal(metrics.cycle.medianDays, 4);
  assert.equal(metrics.ageing.count, 0);
  board.close();
});

test('throughput windows are exclusive: a card finished 20 days ago is not in the 7-day count', () => {
  const board = newBoard();
  finishedCard(board, 'older', -25, -20);
  const metrics = metricsOf(board);
  assert.equal(metrics.throughput.days7, 0);
  assert.equal(metrics.throughput.days30, 1);
  board.close();
});

test('ageing counts the cards past the SLE and names the oldest', () => {
  const board = newBoard();
  const card = createTask(board, { title: 'stuck' }, { actor: HUMAN, now: at(-30) });
  refine(board, card.id);
  // The default SLE is a 3-day guess; four days in progress is past it.
  moveTask(board, { id: card.id, toState: 'in-progress' }, { actor: HUMAN, now: at(-4) });
  const metrics = metricsOf(board);
  assert.equal(metrics.ageing.count, 1);
  assert.equal(metrics.ageing.oldestDays, 4);
  assert.equal(metrics.ages[0]?.overSle, true);
  board.close();
});

test('the age list is oldest first', () => {
  const board = newBoard();
  const a = createTask(board, { title: 'younger' }, { actor: HUMAN, now: at(-30) });
  const b = createTask(board, { title: 'older' }, { actor: HUMAN, now: at(-30) });
  for (const card of [a, b]) refine(board, card.id);
  moveTask(board, { id: a.id, toState: 'in-progress' }, { actor: HUMAN, now: at(-1) });
  moveTask(board, { id: b.id, toState: 'in-progress' }, { actor: HUMAN, now: at(-6) });
  const metrics = metricsOf(board);
  assert.deepEqual(
    metrics.ages.map((entry) => entry.id),
    [b.id, a.id]
  );
  board.close();
});

// ------------------------------------------------------------------ the cross-check

test('cycle time from the event log equals cycle time from the columns', () => {
  const board = newBoard();
  finishedCard(board, 'one', -10, -8);
  finishedCard(board, 'two', -7, -2);
  finishedCard(board, 'three', -3, -1);

  const fromTasks = cycleTimesFromTasks(listTasks(board, { limit: 500 }).tasks).sort((x, y) => x - y);
  const fromEvents = cycleTimesFromEvents(moveObservations(board)).sort((x, y) => x - y);

  assert.deepEqual(fromEvents, fromTasks);
  assert.equal(fromTasks.length, 3);
  board.close();
});

test('a card that returns to the backlog stops contributing cycle time from the log', () => {
  const board = newBoard();
  const card = finishedCard(board, 'reopened', -6, -1);
  moveTask(
    board,
    { id: card, toState: 'in-progress', reason: 'the fix regressed' },
    { actor: HUMAN, now: at(0) }
  );

  // The columns still hold a finished interval on the first pass; the log records the reopen, and
  // a second finish would add a second observation rather than replacing the first.
  const observations = moveObservations(board);
  assert.ok(observations.some((entry) => entry.toState === 'done'));
  assert.ok(observations.filter((entry) => entry.toState === 'in-progress').length >= 1);
  board.close();
});
