/**
 * The browser half's model: what a board payload means, and what a move does to it.
 *
 * **Pure on purpose.** No DOM, no `fetch`, no React. Everything a test wants to pin — column
 * contents, WIP arithmetic, local gate checks, drag targets, age bands — is a function of data
 * here, which is the only way a drag-and-drop board can be tested at all: jsdom's drag events are
 * unreliable, so the logic must not live in the handlers.
 *
 * It imports the **task vocabulary** from the store (`State`, `Task`, `compareInColumn`, the WIP
 * limits) rather than restating it. That is the point of `src/store/types.ts` being pure: one
 * spelling of "in-progress", one definition of column order, shared by the host that writes the
 * rows and the browser that draws them.
 */
import {
  CLASS_LABEL,
  PRIORITY_LABEL,
  STATE_LABEL,
  STATES,
  WIP_STATES,
  compareInColumn,
  stateIndex,
  type DefinitionOfWorkflow,
  type Priority,
  type SavedView,
  type Sprint,
  type State,
  type Task,
  type Template,
} from '../store/types.js';
import type { FlowMetrics } from '../store/metrics.js';

/** Exactly what `GET /api/kanban/board` returns, as the panel consumes it. */
export interface BoardPayload {
  readonly rev: number;
  readonly title: string;
  readonly dow: DefinitionOfWorkflow;
  readonly tasks: readonly Task[];
  readonly metrics: FlowMetrics;
  readonly counts: Readonly<Record<string, number>>;
  readonly views: readonly SavedView[];
  readonly templates: readonly Template[];
  readonly sprints: readonly Sprint[];
  readonly invalid: readonly { readonly id: string; readonly reason: string }[];
  readonly total: number;
  /** Set when the board holds more cards than the panel reads, so the gap is visible. */
  readonly truncated: { readonly shown: number; readonly total: number } | null;
  readonly servedAt: string;
  readonly buildId: string;
}

/** The columns the board draws: everything except `dropped`, which is a view, not a lane. */
export const BOARD_STATES: readonly State[] = STATES.filter((state) => state !== 'dropped');

/** A filter the human can apply from the toolbar. */
export interface ViewFilter {
  readonly state?: readonly State[];
  readonly assignee?: string;
  readonly project?: string;
  /** `null` means "not in a sprint", which is a real question a view can ask. */
  readonly sprintId?: string | null;
  readonly tag?: string;
  readonly priority?: readonly Priority[];
  readonly blocked?: boolean;
  readonly search?: string;
}

/**
 * The "nothing is filtered" value.
 *
 * Frozen because it is shared: a caller that spread it into a new filter and then wrote a field
 * would otherwise edit this constant, and every later board would open with the last selection.
 */
export const EMPTY_FILTER: ViewFilter = Object.freeze({});

/** One drawn column. */
export interface Column {
  readonly state: State;
  readonly label: string;
  readonly cards: readonly Task[];
  /** The WIP limit or ready cap, when the state has one. */
  readonly limit: number | undefined;
  readonly over: boolean;
}

/**
 * The WIP limit that applies to a state.
 *
 * Mirrors `policy.limitFor` on the host. Duplicated deliberately and narrowly: the panel must
 * refuse a drag *before* it sends it, and the host must refuse it again. The host is authoritative —
 * this copy exists so the human sees the refusal instantly rather than after a round trip.
 */
export function limitFor(state: State, dow: DefinitionOfWorkflow): number | undefined {
  if ((WIP_STATES as readonly string[]).includes(state)) return dow.wip[state as 'in-progress' | 'review'];
  if (state === 'ready') return dow.readyCap;
  return undefined;
}

/** Filter the cards the toolbar is currently asking for. */
export function filterCards(tasks: readonly Task[], filter: ViewFilter): Task[] {
  const search = filter.search?.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filter.state !== undefined && filter.state.length > 0 && !filter.state.includes(task.state)) return false;
    if (filter.priority !== undefined && filter.priority.length > 0 && !filter.priority.includes(task.priority)) return false;
    if (filter.assignee !== undefined && task.assignee !== filter.assignee) return false;
    if (filter.project !== undefined && task.project !== filter.project) return false;
    if (filter.sprintId !== undefined && task.sprintId !== filter.sprintId) return false;    if (filter.tag !== undefined && !task.tags.includes(filter.tag)) return false;
    if (filter.blocked === true && task.blockedReason === null) return false;
    if (search !== undefined && search.length > 0) {
      const haystack = `${task.id} ${task.title} ${task.outcome ?? ''} ${task.description ?? ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

/** The columns to draw, in board order, each already sorted by the board's rule. */
export function columnsOf(payload: BoardPayload, filter: ViewFilter = EMPTY_FILTER): Column[] {
  const tasks = filterCards(payload.tasks, filter);
  return BOARD_STATES.map((state) => {
    const cards = tasks.filter((task) => task.state === state).sort(compareInColumn);
    const limit = limitFor(state, payload.dow);
    return {
      state,
      label: STATE_LABEL[state],
      cards,
      limit,
      over: limit !== undefined && cards.length > limit,
    };
  });
}

/** WIP as the guide defines it: started, not finished — blocked cards included. */
export function wipTotal(tasks: readonly Task[]): number {
  return tasks.filter((task) => (WIP_STATES as readonly string[]).includes(task.state)).length;
}

/** Whole days a card has been in progress, or null when it has not started. */
export function ageDays(task: Task, nowIso: string): number | null {
  if (task.startedAt === null) return null;
  const days = (Date.parse(nowIso) - Date.parse(task.startedAt)) / 86_400_000;
  return Math.round(days * 10) / 10;
}

export type AgeBand = 'fresh' | 'ageing' | 'stale';

/** How a card's age reads against the Service Level Expectation. */
export function ageBand(days: number | null, sleDays: number): AgeBand {
  if (days === null) return 'fresh';
  if (days > sleDays * 1.5) return 'stale';
  if (days > sleDays) return 'ageing';
  return 'fresh';
}

/** `3d`, `0.5d`, `—`. Locale-free: the board's numbers must not depend on the machine. */
export function formatAge(days: number | null): string {
  if (days === null) return '—';
  return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
}

/** `P0`, `P1` — the ribbon's text. */
export function priorityBadge(priority: Priority): string {
  return PRIORITY_LABEL[priority].split(' ')[0] ?? priority;
}

/**
 * `P1 · high` — the badge plus the word.
 *
 * The word is not decoration: the amber `P1` fails AA on the light theme's white (≈2.15:1), so the
 * meaning has to survive without the colour. `priorityBadge` stays the short form for the
 * generated projection, which is text on a terminal rather than a 12px badge.
 */
export function priorityText(priority: Priority): string {
  const [code = priority, ...rest] = PRIORITY_LABEL[priority].split(' ');
  return rest.length === 0 ? code : `${code} · ${rest.join(' ')}`;
}

/**
 * The code alone (`P0`), for the card's top row.
 *
 * That row carries the id, the priority and the age inside a 236px lane. Spelling the priority out
 * there wrapped the row and split the id mid-token; the word belongs in the chip row, which wraps
 * gracefully. The drawer and the CLI keep the full `priorityText`.
 */
export function priorityCode(priority: Priority): string {
  return PRIORITY_LABEL[priority].split(' ')[0] ?? priority;
}

/**
 * The priority's word, but only where it earns the space: P0 and P1 are the two a reader must not
 * miss. P2-P4 return null, so the common card stays quiet.
 */
export function priorityWord(priority: Priority): string | null {
  if (priority !== 'p0-critical' && priority !== 'p1-high') return null;
  const rest = PRIORITY_LABEL[priority].split(' ').slice(1).join(' ');
  return rest.length === 0 ? null : rest;
}

export function classLabel(task: Task): string {
  return CLASS_LABEL[task.classOfService];
}

/**
 * Position for dropping a card at `index` in a column.
 *
 * Position is a real number, so a drop between two cards takes the midpoint and no other row has to
 * move. Dropping at the end appends past the last card, and an empty column starts at 0.
 */
export function positionForIndex(cards: readonly Task[], index: number): number {
  if (cards.length === 0) return 0;
  const clamped = Math.max(0, Math.min(index, cards.length));
  if (clamped === 0) return (cards[0] as Task).position - 1;
  if (clamped >= cards.length) return (cards[cards.length - 1] as Task).position + 1;
  const before = cards[clamped - 1] as Task;
  const after = cards[clamped] as Task;
  return (before.position + after.position) / 2;
}

/** The result of a local gate check: allowed, or refused with the reason the human will read. */
export type LocalVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly missing?: readonly string[] };

/** Unticked checks on a card, in checklist order. */
export function missingChecks(task: Task, dow: DefinitionOfWorkflow, gate: 'dor' | 'dod'): string[] {
  const required = gate === 'dor' ? dow.dor : dow.dod;
  const checked: Record<string, unknown> = gate === 'dor' ? { ...task.dor } : { ...task.dod };
  return required.filter((id) => checked[id] === undefined);
}

/**
 * Would the host accept this move? Asked before sending, so the refusal is instantaneous.
 *
 * This is **not** a copy of `policy.checkMove`; it is a best-effort pre-check and the host is
 * authoritative on every disagreement. Two differences remain, and both fail open — the panel sends
 * the move, the host refuses it, and the host's message is what the human reads:
 *
 * 1. There is no human-only check on `force`. The browser cannot know which actor the host will
 *    attribute the call to, so `policy.checkMove` is what declines an agent's exception.
 * 2. WIP is counted from the panel's snapshot rather than inside the write transaction, so a limit
 *    that filled up since the last poll is seen by the host and not here.
 *
 * Everything it *can* mirror, it mirrors: the exception's reason is required before a same-state
 * move is waved through (as the host requires it), and the remaining gates run in the host's order —
 * the exception, the Definition of Ready, the Definition of Done, the drop/reopen reason, the
 * blocker, then WIP. The wording here is deliberately short; the host's is the authoritative one.
 */
export function checkMoveLocally(input: {
  readonly payload: BoardPayload;
  readonly task: Task;
  readonly toState: State;
  readonly force?: boolean;
  readonly reason?: string;
}): LocalVerdict {
  const { payload, task, toState } = input;
  const forcing = input.force === true;

  // The exception first, in the host's order: a forced move needs a written reason before anything
  // else is considered — including a same-state move, which `policy.checkMove` only passes after
  // the reason has been validated.
  if (forcing && (input.reason === undefined || input.reason.trim().length === 0)) {
    return { ok: false, reason: 'an exception needs a written reason' };
  }

  if (task.state === toState) return { ok: true };

  if (!forcing && task.state === 'backlog' && toState !== 'dropped') {
    const missing = missingChecks(task, payload.dow, 'dor');
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `cannot leave the backlog: ${missing.length} Definition of Ready check(s) unticked`,
        missing,
      };
    }
  }

  if (!forcing && toState === 'done') {
    const missing = missingChecks(task, payload.dow, 'dod');
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `cannot enter done: ${missing.length} Definition of Done check(s) unticked`,
        missing,
      };
    }
  }

  if (toState === 'dropped' && (input.reason === undefined || input.reason.trim().length === 0)) {
    return { ok: false, reason: 'dropping a card needs a reason' };
  }
  if (task.state === 'done' && toState !== 'dropped' && (input.reason === undefined || input.reason.trim().length === 0)) {
    return { ok: false, reason: 'reopening a finished card needs a reason' };
  }
  if (task.blockedReason !== null && (WIP_STATES as readonly string[]).includes(toState)) {
    return { ok: false, reason: `blocked: ${task.blockedReason}` };
  }
  if (!forcing && task.classOfService !== 'expedite') {
    const limit = limitFor(toState, payload.dow);
    if (limit !== undefined) {
      const occupied = filterCards(payload.tasks, { state: [toState] }).length;
      if (occupied >= limit) {
        return { ok: false, reason: `the ${STATE_LABEL[toState].toLowerCase()} limit is ${limit} and it is full` };
      }
    }
  }
  return { ok: true };
}

/** The states a card can be moved to, for the keyboard path and the card menu. */
export function moveTargets(current: State): State[] {
  return STATES.filter((state) => state !== current);
}

/**
 * Apply a move to the local board so the drag lands instantly.
 *
 * This is a projection, not a decision: it recomputes exactly what the host's `moveTask` writes
 * (state, position, started/finished points) so the optimistic view matches the server's answer. A
 * mismatch is corrected by the next refresh, and a refusal rolls the card back to where it was.
 */
export function applyLocalMove(payload: BoardPayload, taskId: string, toState: State, position: number, nowIso: string): BoardPayload {
  const tasks = payload.tasks.map((task) => {
    if (task.id !== taskId) return task;
    const started =
      task.startedAt ?? ((WIP_STATES as readonly string[]).includes(toState) || toState === 'done' ? nowIso : null);
    const finished = toState === 'done' ? (task.finishedAt ?? nowIso) : null;
    return { ...task, state: toState, position, startedAt: started, finishedAt: finished, rev: task.rev + 1 };
  });
  const counts: Record<string, number> = {};
  for (const state of STATES) counts[state] = 0;
  for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
  return { ...payload, tasks, counts };
}

/**
 * Is a filter asking for anything at all?
 *
 * The view buttons use this to tell "no view is active" from "a view is active": when nothing is
 * filtered, the panel's own `All` control is the pressed one. The state quick chips and the two
 * helpers that fed them (`activeStates`, `filterableStates`) went with the chip row in the distill
 * pass — the views are the panel's state filtering now.
 */
export function hasFilter(filter: ViewFilter): boolean {
  return Object.values(filter).some((value) => value !== undefined);
}

/**
 * Do two filters ask for the same board?
 *
 * The toolbar needs this to say which view is current: a saved view stores the filter object and
 * the store holds another copy of it, so identity comparison would mark every view inactive the
 * moment it was clicked. Canonicalised as sorted `key=value` pairs.
 *
 * An array value is **sorted before it is serialised**, because the same question can be asked in a
 * different order: a view saved as `['done','ready']` and the chips that append `['ready','done']`
 * are the same filter, and comparing the arrays verbatim left the saved view's button unpressed and
 * the toolbar highlighting nothing. The two arrays a filter can carry (`state`, `priority`) are
 * sets, so their order is not part of the question.
 */
export function sameFilter(a: ViewFilter, b: ViewFilter): boolean {
  const canonical = (filter: ViewFilter): string =>
    Object.entries(filter)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${JSON.stringify(Array.isArray(value) ? [...value].sort() : value)}`)
      .sort()
      .join('&');
  return canonical(a) === canonical(b);
}

/** `p * 100`, without inventing a decimal place: `0.855` stays `85.5%`, not `86%`. */
export function formatPercent(p: number): string {
  const percent = p * 100;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

/** An ISO instant as the history line reads it: `2026-10-01 00:00:00Z`, or the input if unparseable. */
export function formatStamp(iso: string): string {
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) return iso;
  const date = new Date(millis);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

/** Sort a card list by the state order — used by the list-style views, not the board. */
export function byStateThenColumn(a: Task, b: Task): number {
  const byState = stateIndex(a.state) - stateIndex(b.state);
  return byState !== 0 ? byState : compareInColumn(a, b);
}
