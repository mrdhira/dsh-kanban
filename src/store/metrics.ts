/**
 * The four mandatory flow metrics, and the Service Level Expectation derived from them.
 *
 * The Kanban Guide requires exactly these: **WIP** (started but not finished), **throughput**
 * (finished per unit of time — an exact count, not a rate estimate), **work item age** (started to
 * now), and **cycle time** (started to finished). The SLE follows from cycle time: a period plus a
 * probability, e.g. "85% of items finish in 8 days or less", and the guide explicitly allows a
 * best guess until enough history exists — which is why the guess is labelled as a guess and not
 * dressed up as data.
 *
 * Everything here is derived, so there is nothing to keep in sync. The columns the metrics read
 * (`started_at`, `finished_at`) are written only by the one place that moves a card, and the event
 * log records the same transition, which is why `cycleTimesFromEvents` exists: it recomputes the
 * same number a second way so a test can prove the two agree.
 */
import { WIP_STATES, type DefinitionOfWorkflow, type State, type Task } from './types.js';

/** Below this many finished items, the SLE is a guess rather than a computed expectation. */
export const MIN_HISTORY_FOR_SLE = 10;

const MS_PER_DAY = 86_400_000;

/** Exact days between two ISO instants, rounded to two decimals so output is stable. */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  return Math.round(((Date.parse(toIso) - Date.parse(fromIso)) / MS_PER_DAY) * 100) / 100;
}

/**
 * Nearest-rank percentile — no interpolation, so the value is always one that actually happened.
 * With no observations there is no percentile, and `null` says so rather than `0`, which would
 * read as "instant".
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 100) / 100;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return Math.round(((lower + upper) / 2) * 100) / 100;
}

export interface AgeEntry {
  readonly id: string;
  readonly title: string;
  readonly state: State;
  readonly days: number;
  readonly overSle: boolean;
}

export interface CycleStats {
  readonly count: number;
  readonly medianDays: number | null;
  readonly p85Days: number | null;
  readonly meanDays: number | null;
  readonly minDays: number | null;
  readonly maxDays: number | null;
}

export interface FlowMetrics {
  readonly generatedAt: string;
  readonly boardRev: number;
  readonly wip: number;
  readonly wipByState: Readonly<Record<string, number>>;
  readonly countsByState: Readonly<Record<string, number>>;
  readonly throughput: { readonly days7: number; readonly days30: number };
  readonly ages: readonly AgeEntry[];
  readonly cycle: CycleStats;
  readonly sle: { readonly p: number; readonly days: number; readonly source: 'history' | 'guess'; readonly basis: number };
  readonly ageing: { readonly count: number; readonly oldestDays: number | null };
}

/** Cycle times in days, from the cards themselves. */
export function cycleTimesFromTasks(tasks: readonly Task[]): number[] {
  const out: number[] = [];
  for (const task of tasks) {
    if (task.startedAt !== null && task.finishedAt !== null) {
      out.push(daysBetweenIso(task.startedAt, task.finishedAt));
    }
  }
  return out;
}

/**
 * The SLE, from history when there is enough of it.
 *
 * `Math.ceil` on the percentile because "8.4 days" is not a forecast anyone can hold in their
 * head, and rounding *down* would set an expectation the data does not support. The floor of one
 * day exists so a board of same-day work does not advertise "85% finish in 0 days".
 */
export function deriveSle(
  cycleTimes: readonly number[],
  dow: DefinitionOfWorkflow
): FlowMetrics['sle'] {
  if (cycleTimes.length < MIN_HISTORY_FOR_SLE) {
    return { p: dow.sle.p, days: dow.sle.days, source: 'guess', basis: cycleTimes.length };
  }
  const p85 = percentile(cycleTimes, dow.sle.p);
  if (p85 === null) {
    return { p: dow.sle.p, days: dow.sle.days, source: 'guess', basis: cycleTimes.length };
  }
  return { p: dow.sle.p, days: Math.max(1, Math.ceil(p85)), source: 'history', basis: cycleTimes.length };
}

export interface FlowMetricsInput {
  readonly tasks: readonly Task[];
  readonly now: Date;
  readonly dow: DefinitionOfWorkflow;
  readonly boardRev: number;
}

/** Compute all four metrics plus the SLE from the current cards. */
export function computeFlowMetrics(input: FlowMetricsInput): FlowMetrics {
  const { tasks, now, dow, boardRev } = input;
  const nowIso = now.toISOString();

  const countsByState: Record<string, number> = {};
  for (const state of ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped'] as const) {
    countsByState[state] = 0;
  }
  for (const task of tasks) countsByState[task.state] = (countsByState[task.state] ?? 0) + 1;

  const wipByState: Record<string, number> = {};
  let wip = 0;
  for (const state of WIP_STATES) {
    const count = countsByState[state] ?? 0;
    wipByState[state] = count;
    wip += count;
  }

  const cycleTimes = cycleTimesFromTasks(tasks);
  const sle = deriveSle(cycleTimes, dow);

  const finishedWithin = (days: number): number =>
    tasks.filter(
      (task) => task.finishedAt !== null && daysBetweenIso(task.finishedAt, nowIso) <= days
    ).length;

  const ages: AgeEntry[] = tasks
    .filter((task) => task.startedAt !== null && task.finishedAt === null)
    .map((task) => {
      const days = daysBetweenIso(task.startedAt as string, nowIso);
      return {
        id: task.id,
        title: task.title,
        state: task.state,
        days,
        overSle: days > sle.days,
      };
    })
    .sort((a, b) => b.days - a.days);

  const oldest = ages.length > 0 ? (ages[0] as AgeEntry).days : null;

  return {
    generatedAt: nowIso,
    boardRev,
    wip,
    wipByState,
    countsByState,
    throughput: { days7: finishedWithin(7), days30: finishedWithin(30) },
    ages,
    cycle: {
      count: cycleTimes.length,
      medianDays: median(cycleTimes),
      p85Days: percentile(cycleTimes, dow.sle.p),
      meanDays: mean(cycleTimes),
      minDays: cycleTimes.length > 0 ? Math.min(...cycleTimes) : null,
      maxDays: cycleTimes.length > 0 ? Math.max(...cycleTimes) : null,
    },
    sle,
    ageing: { count: ages.filter((entry) => entry.overSle).length, oldestDays: oldest },
  };
}

/** One `moved` observation, as the event log stores it. */
export interface MoveObservation {
  readonly taskId: string;
  readonly at: string;
  readonly fromState: State | null;
  readonly toState: State | null;
  readonly kind: string;
}

/**
 * Cycle times recomputed from the **event log** instead of the columns.
 *
 * This is the cross-check that keeps the derived metrics honest: if a card's `started_at` were
 * ever set without a matching `moved` event, the two numbers would disagree and a test would say
 * so.
 */
export function cycleTimesFromEvents(observations: readonly MoveObservation[]): number[] {
  const started = new Map<string, string>();
  const out: number[] = [];
  const ordered = [...observations].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  for (const observation of ordered) {
    if (observation.toState === 'in-progress' && !started.has(observation.taskId)) {
      started.set(observation.taskId, observation.at);
    }
    if (observation.toState === 'done') {
      const from = started.get(observation.taskId);
      if (from !== undefined && daysBetweenIso(from, observation.at) >= 0) {
        out.push(daysBetweenIso(from, observation.at));
      }
    }
    if (observation.toState === 'backlog' || observation.toState === 'dropped') {
      started.delete(observation.taskId);
    }
  }

  return out;
}
