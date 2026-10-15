/**
 * The policy tables.
 *
 * Ordered the way the code flows — a successful move first, then each gate in the order
 * `checkMove` applies them — because a failure table ordered by intuition hides the fact that the
 * gates are checked in a specific sequence, and sequence is behaviour when two gates could both
 * object.
 *
 * These run against `lib/v1/store/policy.js` directly: no database, no clock, no fixtures beyond a
 * card literal. That is what makes every case cheap enough to pin individually.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEdit,
  checkMove,
  checkSprintWindow,
  missingChecks,
  daysBetween,
  limitFor,
  type PolicyResult,
} from '../lib/v1/store/index.js';
import { DEFAULT_DOW } from '../lib/v1/store/index.js';
import { AGENT, HUMAN, makeTask } from './helpers.ts';

const empty = { backlog: 0, ready: 0, 'in-progress': 0, review: 0, done: 0, dropped: 0 };

/** Every DoR and DoD check, ticked. */
const allChecks = Object.fromEntries(
  [...DEFAULT_DOW.dor, ...DEFAULT_DOW.dod].map((id) => [id, { at: '2026-10-15T12:00:00.000Z', by: 'human:dhira' }])
);

// ------------------------------------------------------------------ positive cases

test('a refined card may leave the backlog', () => {
  const card = makeTask({ dor: allChecks });
  const verdict = checkMove({ task: card, toState: 'ready', dow: DEFAULT_DOW, counts: empty, actor: HUMAN });
  assert.deepEqual(verdict, { ok: true });
});

test('a card with a complete DoD may finish', () => {
  const card = makeTask({ state: 'review', dod: allChecks, startedAt: '2026-10-01T00:00:00.000Z' });
  const verdict = checkMove({ task: card, toState: 'done', dow: DEFAULT_DOW, counts: empty, actor: AGENT });
  assert.deepEqual(verdict, { ok: true });
});

test('a move within the same column is allowed (it is a reorder)', () => {
  const card = makeTask({ state: 'in-progress', startedAt: '2026-10-14T00:00:00.000Z' });
  const verdict = checkMove({ task: card, toState: 'in-progress', dow: DEFAULT_DOW, counts: empty, actor: AGENT });
  assert.deepEqual(verdict, { ok: true });
});

test('an expedite card bypasses the WIP limit', () => {
  const card = makeTask({ classOfService: 'expedite', dor: allChecks });
  const verdict = checkMove({
    task: card,
    toState: 'in-progress',
    dow: DEFAULT_DOW,
    counts: { ...empty, 'in-progress': 99 },
    actor: HUMAN,
  });
  assert.deepEqual(verdict, { ok: true });
});

test('the human may except a gate with a reason', () => {
  const card = makeTask();
  const verdict = checkMove({
    task: card,
    toState: 'ready',
    dow: DEFAULT_DOW,
    counts: empty,
    actor: HUMAN,
    force: true,
    reason: 'hotfix demanded by the deploy window',
  });
  assert.deepEqual(verdict, { ok: true });
});

test('dropping with a reason is allowed from any state', () => {
  const card = makeTask({ state: 'in-progress', startedAt: '2026-10-14T00:00:00.000Z' });
  const verdict = checkMove({
    task: card,
    toState: 'dropped',
    dow: DEFAULT_DOW,
    counts: empty,
    actor: AGENT,
    reason: 'superseded by T-020',
  });
  assert.deepEqual(verdict, { ok: true });
});

test('an unrefined card may be dropped — requirement is a claim about future work', () => {
  const card = makeTask();
  const verdict = checkMove({
    task: card,
    toState: 'dropped',
    dow: DEFAULT_DOW,
    counts: empty,
    actor: AGENT,
    reason: 'we are not doing this',
  });
  assert.deepEqual(verdict, { ok: true });
});

test('reopening a finished card is allowed with a reason', () => {
  const card = makeTask({ state: 'done', startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-02T00:00:00.000Z' });
  const verdict = checkMove({
    task: card,
    toState: 'in-progress',
    dow: DEFAULT_DOW,
    counts: empty,
    actor: AGENT,
    reason: 'the fix regressed',
  });
  assert.deepEqual(verdict, { ok: true });
});

// ------------------------------------------------------------------ negative cases, in check order

interface RefusalCase {
  readonly name: string;
  readonly verdict: () => PolicyResult;
  readonly code: string;
  readonly missing?: readonly string[];
}

const refusals: readonly RefusalCase[] = [
  {
    name: 'an agent may not except a gate',
    verdict: () =>
      checkMove({ task: makeTask(), toState: 'ready', dow: DEFAULT_DOW, counts: empty, actor: AGENT, force: true, reason: 'because' }),
    code: 'human-only',
  },
  {
    name: 'an exception without a reason is refused',
    verdict: () =>
      checkMove({ task: makeTask(), toState: 'ready', dow: DEFAULT_DOW, counts: empty, actor: HUMAN, force: true, reason: '   ' }),
    code: 'missing-reason',
  },
  {
    name: 'an unrefined card may not leave the backlog',
    verdict: () => checkMove({ task: makeTask(), toState: 'ready', dow: DEFAULT_DOW, counts: empty, actor: AGENT }),
    code: 'dor-incomplete',
    missing: ['outcome', 'acceptance', 'write-scope', 'estimate'],
  },
  {
    name: 'an unrefined card may not jump straight into work',
    verdict: () => checkMove({ task: makeTask(), toState: 'in-progress', dow: DEFAULT_DOW, counts: empty, actor: AGENT }),
    code: 'dor-incomplete',
  },
  {
    name: 'an half-refined card names only what is missing',
    verdict: () =>
      checkMove({
        task: makeTask({ dor: { outcome: { at: 'x', by: 'y' } } }),
        toState: 'ready',
        dow: DEFAULT_DOW,
        counts: empty,
        actor: AGENT,
      }),
    code: 'dor-incomplete',
    missing: ['acceptance', 'write-scope', 'estimate'],
  },
  {
    name: 'a card without its DoD may not finish',
    verdict: () =>
      checkMove({
        task: makeTask({ state: 'review', startedAt: '2026-10-01T00:00:00.000Z' }),
        toState: 'done',
        dow: DEFAULT_DOW,
        counts: empty,
        actor: AGENT,
      }),
    code: 'dod-incomplete',
  },
  {
    name: 'dropping without a reason is refused',
    verdict: () => checkMove({ task: makeTask(), toState: 'dropped', dow: DEFAULT_DOW, counts: empty, actor: AGENT }),
    code: 'missing-reason',
  },
  {
    name: 'reopening without a reason is refused',
    verdict: () =>
      checkMove({
        task: makeTask({ state: 'done', startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-02T00:00:00.000Z' }),
        toState: 'in-progress',
        dow: DEFAULT_DOW,
        counts: empty,
        actor: AGENT,
      }),
    code: 'missing-reason',
  },
  {
    name: 'a blocked card may not be moved into work',
    verdict: () =>
      checkMove({
        task: makeTask({ blockedReason: 'waiting on the vendor', dor: allChecks }),
        toState: 'in-progress',
        dow: DEFAULT_DOW,
        counts: empty,
        actor: AGENT,
      }),
    code: 'illegal-transition',
  },
  {
    name: 'the in-progress WIP limit is enforced',
    verdict: () =>
      checkMove({
        task: makeTask({ state: 'ready', dor: allChecks }),
        toState: 'in-progress',
        dow: DEFAULT_DOW,
        counts: { ...empty, 'in-progress': DEFAULT_DOW.wip['in-progress'] },
        actor: AGENT,
      }),
    code: 'wip-limit',
  },
  {
    name: 'the review WIP limit is enforced',
    verdict: () =>
      checkMove({
        task: makeTask({ state: 'in-progress', startedAt: '2026-10-14T00:00:00.000Z' }),
        toState: 'review',
        dow: DEFAULT_DOW,
        counts: { ...empty, review: DEFAULT_DOW.wip.review },
        actor: AGENT,
      }),
    code: 'wip-limit',
  },
  {
    name: 'the ready queue cap is enforced',
    verdict: () =>
      checkMove({
        task: makeTask({ dor: allChecks }),
        toState: 'ready',
        dow: DEFAULT_DOW,
        counts: { ...empty, ready: DEFAULT_DOW.readyCap },
        actor: AGENT,
      }),
    code: 'ready-cap',
  },
];

for (const testCase of refusals) {
  test(`refused: ${testCase.name}`, () => {
    const verdict = testCase.verdict();
    assert.equal(verdict.ok, false, 'expected a refusal');
    if (verdict.ok) return;
    assert.equal(verdict.code, testCase.code);
    if (testCase.missing !== undefined) assert.deepEqual(verdict.missing, testCase.missing);
  });
}

// ------------------------------------------------------------------ occupancy arithmetic

test('a card already in the column counts against itself, not twice', () => {
  // Three cards in progress against a limit of two: the card being reordered is one of them.
  const card = makeTask({ state: 'in-progress', startedAt: '2026-10-14T00:00:00.000Z' });
  const verdict = checkMove({
    task: card,
    toState: 'review',
    dow: DEFAULT_DOW,
    counts: { ...empty, 'in-progress': 3, review: 0 },
    actor: AGENT,
  });
  assert.deepEqual(verdict, { ok: true });
});

test('limitFor names the WIP limit, the queue cap, and nothing else', () => {
  assert.equal(limitFor('in-progress', DEFAULT_DOW), DEFAULT_DOW.wip['in-progress']);
  assert.equal(limitFor('review', DEFAULT_DOW), DEFAULT_DOW.wip.review);
  assert.equal(limitFor('ready', DEFAULT_DOW), DEFAULT_DOW.readyCap);
  assert.equal(limitFor('backlog', DEFAULT_DOW), undefined);
  assert.equal(limitFor('done', DEFAULT_DOW), undefined);
});

// ------------------------------------------------------------------ the edit gate

test('the human may set a priority', () => {
  const verdict = checkEdit({ task: makeTask(), patch: { priority: 'p0-critical' }, actor: HUMAN });
  assert.deepEqual(verdict, { ok: true });
});

test('an agent may refine prose and assignment', () => {
  const verdict = checkEdit({
    task: makeTask(),
    patch: { assignee: 'verifier', outcome: 'the strip shows peak/off', tags: ['metrics'] },
    actor: AGENT,
  });
  assert.deepEqual(verdict, { ok: true });
});

test('an agent may leave the priority untouched', () => {
  const verdict = checkEdit({ task: makeTask({ priority: 'p2-normal' }), patch: { priority: 'p2-normal' }, actor: AGENT });
  assert.deepEqual(verdict, { ok: true });
});

test('refused: an agent may not set a priority', () => {
  const verdict = checkEdit({ task: makeTask(), patch: { priority: 'p0-critical' }, actor: AGENT });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, 'human-only');
});

test('refused: an agent may not set a class of service', () => {
  const verdict = checkEdit({ task: makeTask(), patch: { classOfService: 'expedite' }, actor: AGENT });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, 'human-only');
});

test('refused: an agent may not claim a blocked card is a priority change', () => {
  const verdict = checkEdit({ task: makeTask(), patch: { priority: 'p1-high' }, actor: { kind: 'plugin', id: 'importer' } });
  assert.equal(verdict.ok, false);
});

// ------------------------------------------------------------------ the sprint timebox

test('a one-week sprint is valid', () => {
  assert.deepEqual(checkSprintWindow('2026-10-15', '2026-10-22'), { ok: true });
});

test('exactly 31 days is valid — the Scrum Guide says one month or less', () => {
  assert.deepEqual(checkSprintWindow('2026-10-01', '2026-11-01'), { ok: true });
});

test('refused: a 32-day sprint exceeds the timebox', () => {
  const verdict = checkSprintWindow('2026-10-01', '2026-11-02');
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, 'illegal-transition');
});

test('refused: a zero-length sprint', () => {
  assert.equal(checkSprintWindow('2026-10-01', '2026-10-01').ok, false);
});

test('refused: a reversed sprint window', () => {
  assert.equal(checkSprintWindow('2026-10-10', '2026-10-01').ok, false);
});

test('refused: an unparseable date', () => {
  assert.equal(checkSprintWindow('next monday', '2026-10-22').ok, false);
});

// ------------------------------------------------------------------ the helpers themselves

test('missingChecks reports unticked ids in the order the checklist declares', () => {
  assert.deepEqual(missingChecks({ outcome: {} }, ['outcome', 'acceptance', 'write-scope']), ['acceptance', 'write-scope']);
});

test('missingChecks is empty when everything is ticked', () => {
  assert.deepEqual(missingChecks({ a: {}, b: {} }, ['a', 'b']), []);
});

test('daysBetween is exact arithmetic, not calendar days', () => {
  assert.equal(daysBetween('2026-10-01T00:00:00.000Z', '2026-10-02T12:00:00.000Z'), 1.5);
});
