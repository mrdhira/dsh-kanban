/**
 * Shared fixtures for the suite.
 *
 * Two rules this file exists to respect:
 *
 * - **Tests exercise built output.** Every import comes from `../lib/v1/store/`, never from
 *   `src/`. Five test files once validated stale pre-port artifacts that were no longer shipped:
 *   green, and worthless. `pretest` rebuilds, and the freshness of `lib` is a gate, not a hope.
 * - **Time is a parameter.** Every mutation takes `now`, so nothing here depends on the wall
 *   clock, and a test can construct a three-week age without waiting three weeks.
 */
import {
  openBoard,
  type Actor,
  type Board,
  type CheckId,
  type Task,
} from '../lib/v1/store/index.js';

/** A fixed instant, so every generated timestamp in the suite is deterministic. */
export const NOW = new Date('2026-10-15T12:00:00.000Z');

/** The human. Used wherever a rule is human-only. */
export const HUMAN: Actor = { kind: 'human', id: 'dhira' };

/** An agent session. Used wherever a rule is meant to stop an agent. */
export const AGENT: Actor = { kind: 'agent', id: 'sess-test' };

export function newBoard(): Board {
  return openBoard(':memory:');
}

/** A fully-populated card, for the pure policy tables where no database is wanted. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: 'T-001',
    title: 'A card',
    outcome: null,
    description: null,
    acceptance: null,
    state: 'backlog',
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
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    startedAt: null,
    finishedAt: null,
    createdBy: 'human:dhira',
    updatedBy: 'human:dhira',
  };
  return { ...base, ...overrides };
}

/** Every Definition of Ready check ticked, as a card that has been refined. */
export function fullDor(ids: readonly string[]): Record<string, { at: string; by: string }> {
  return Object.fromEntries(ids.map((id) => [id as CheckId, { at: NOW.toISOString(), by: 'human:dhira' }]));
}
