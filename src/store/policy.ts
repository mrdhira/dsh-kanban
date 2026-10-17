/**
 * The policy engine: every rule the board enforces, as pure functions.
 *
 * One module decides, and three callers obey — the tools, the HTTP route and the CLI. That is the
 * whole point: a rule enforced in the UI is a suggestion, and a rule enforced twice will differ.
 * These functions take plain data and return a verdict; they never read the database, never throw
 * for a policy decision, and never look at the clock. Everything that could make them
 * non-deterministic is a parameter, which is also why the table-driven tests can pin every case.
 *
 * The rules come from the Definition of Workflow (`types.ts`), and their justification is in the
 * Kanban Guide's "Actively Managing Items in a Workflow": control WIP, do not let items age
 * unnecessarily, and unblock blocked work — with any exception to WIP control made explicit.
 */
import {
  MAX_SPRINT_DAYS,
  PRIORITIES,
  type Actor,
  type ClassOfService,
  type DefinitionOfWorkflow,
  type Priority,
  type State,
  type Task,
  type TaskPatch,
  WIP_STATES,
  type WipState,
} from './types.js';

export type PolicyCode =
  | 'illegal-transition'
  | 'dor-incomplete'
  | 'dod-incomplete'
  | 'wip-limit'
  | 'ready-cap'
  | 'human-only'
  | 'missing-reason';

export interface PolicyFailure {
  readonly ok: false;
  readonly code: PolicyCode;
  readonly message: string;
  /** The checklist ids that must be ticked, when the failure is a gate. */
  readonly missing?: readonly string[];
}

export type PolicyResult = { readonly ok: true } | PolicyFailure;

const pass: PolicyResult = { ok: true };

function fail(code: PolicyCode, message: string, missing?: readonly string[]): PolicyFailure {
  return missing === undefined ? { ok: false, code, message } : { ok: false, code, message, missing };
}

/** `agent:abc123` — one stable string for the event log and the `created_by` columns. */
export function actorId(actor: Actor): string {
  return `${actor.kind}:${actor.id}`;
}

/** Only the human may set a priority, choose expedite, or except a gate. */
export function isHuman(actor: Actor): boolean {
  return actor.kind === 'human';
}

/** The checklist ids still unticked on a card. */
export function missingChecks(
  checked: Readonly<Record<string, unknown>>,
  required: readonly string[],
  /** Ids satisfied by recorded data, so a tick is not the only way in. See `suppliedChecks`. */
  supplied: readonly string[] = []
): string[] {
  return required.filter((id) => checked[id] === undefined && !supplied.includes(id));
}

/**
 * The Definition of Ready items a card satisfies with recorded data rather than a tick.
 *
 * `write-scope` is the one, and it is the whole defect this exists for: the item named a fact no
 * `kanban_*` tool could supply, so an agent-authored card was gated on something it could not
 * provide. A stored scope **is** the named write scope — the tick remains a path (the CLI, a card
 * imported from the pre-Kanban board, a human's judgement), but the data alone answers the item.
 */
export function suppliedChecks(task: { readonly writeScopes: readonly string[] }): readonly string[] {
  return task.writeScopes.length > 0 ? ['write-scope'] : [];
}

/** Is this state one of the WIP states — after *started*, before *finished*? */
export function isWip(state: State): state is WipState {
  return (WIP_STATES as readonly string[]).includes(state);
}

/**
 * The WIP limit applied to a state, or `undefined` when the state is not controlled.
 *
 * `ready` has a *queue* cap rather than a WIP limit: it is not work in progress, but an unbounded
 * ready queue turns refinement into a second backlog, which is the failure the guide warns about.
 */
export function limitFor(state: State, dow: DefinitionOfWorkflow): number | undefined {
  if (isWip(state)) return dow.wip[state];
  if (state === 'ready') return dow.readyCap;
  return undefined;
}

/** Whole days between two ISO instants, as an exact real number. Used by the sprint invariant. */
export function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
}

/**
 * The Scrum Guide's timebox: a sprint is one month or less, and has a positive length.
 *
 * **No rounding.** `Math.round` accepted a 31.375-day sprint as 31 days and a twelve-hour sprint as
 * one — the invariant is an exact duration, and rounding it is how a rule that reads as enforced
 * stops being true at the boundary. The number in the message is the real one, so a refusal is
 * actionable rather than approximate.
 */
export function checkSprintWindow(start: string, end: string): PolicyResult {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return fail('illegal-transition', 'sprint start and end must both be ISO dates');
  }
  const days = (endMs - startMs) / 86_400_000;
  const shown = Math.round(days * 1000) / 1000;
  if (days < 1) return fail('illegal-transition', `a sprint must be at least one day long; got ${shown}`);
  if (days > MAX_SPRINT_DAYS) {
    return fail(
      'illegal-transition',
      `a sprint may not exceed ${MAX_SPRINT_DAYS} days (the Scrum Guide's "one month or less"); got ${shown}`
    );
  }
  return pass;
}

export interface MoveCheckInput {
  readonly task: Task;
  readonly toState: State;
  readonly dow: DefinitionOfWorkflow;
  /** Current occupancy per state, read inside the same transaction as the write. */
  readonly counts: Readonly<Record<string, number>>;
  readonly actor: Actor;
  readonly force?: boolean;
  readonly reason?: string;
}

/**
 * Can this card move to `toState`?
 *
 * Order matters: the gate a human must satisfy is reported before the WIP limit they may want to
 * except, because "the checklist is empty" is actionable and "the column is full" invites a
 * bypass that would not have been enough anyway.
 */
export function checkMove(input: MoveCheckInput): PolicyResult {
  const { task, toState, dow, counts, actor } = input;
  const forcing = input.force === true;

  if (forcing) {
    if (!isHuman(actor)) {
      return fail('human-only', 'only the human may except a gate; an agent must satisfy it or leave the card where it is');
    }
    if (input.reason === undefined || input.reason.trim().length === 0) {
      return fail('missing-reason', 'an exception requires a written reason, because the Definition of Workflow must state it');
    }
  }

  if (task.state === toState) return pass;

  // Out of backlog: refinement is what DoR protects, and starting unrefined work is the exact
  // failure it exists to prevent — so the gate covers every exit *except* abandoning the card.
  //
  // Dropping is deliberately exempt. Requirement is a claim about future work; a card nobody is
  // going to do has no future to refine for, and making "throw this away" harder than "do this"
  // is how a backlog fills with things nobody dares delete.
  if (task.state === 'backlog' && toState !== 'dropped') {
    const missing = missingChecks(task.dor, dow.dor, suppliedChecks(task));
    if (missing.length > 0 && !forcing) {
      // A refusal has to name something the caller can supply. `write-scope` missing means no scope
      // is recorded, and the fix is a field, not a judgement call — so it says which field.
      const scopeHint = missing.includes('write-scope')
        ? ' — write-scope has no recorded scope: pass writeScope (a workspace-relative file or directory prefix, or a list) to kanban_create or kanban_update'
        : '';
      return fail(
        'dor-incomplete',
        `cannot leave backlog: ${missing.length} Definition of Ready check(s) are unticked${scopeHint}`,
        missing
      );
    }
  }

  if (toState === 'done') {
    const missing = missingChecks(task.dod, dow.dod);
    if (missing.length > 0 && !forcing) {
      return fail(
        'dod-incomplete',
        `cannot enter done: ${missing.length} Definition of Done check(s) are unticked`,
        missing
      );
    }
  }

  if (toState === 'dropped' && (input.reason === undefined || input.reason.trim().length === 0)) {
    return fail('missing-reason', 'dropping a card requires a reason so the throughput number stays honest');
  }

  // Reopening finished work is legitimate, but it must be *explained*: it changes cycle time.
  if (task.state === 'done' && toState !== 'dropped') {
    if (input.reason === undefined || input.reason.trim().length === 0) {
      return fail('missing-reason', 'reopening a finished card requires a reason');
    }
  }

  const blocked = task.blockedReason !== null;
  if (blocked && isWip(toState)) {
    return fail(
      'illegal-transition',
      `this card is blocked (${task.blockedReason ?? ''}); unblock it before moving it into ${toState}`
    );
  }

  // WIP control. `expedite` is the single documented exception, and it is human-only by
  // `checkEdit`, so an agent cannot grant itself one.
  if (!forcing && task.classOfService !== 'expedite') {
    const limit = limitFor(toState, dow);
    if (limit !== undefined) {
      const occupied = counts[toState] ?? 0;
      const alreadyCounted = task.state === toState ? 1 : 0;
      if (occupied - alreadyCounted >= limit) {
        return fail(
          toState === 'ready' ? 'ready-cap' : 'wip-limit',
          `the ${toState} limit is ${limit} and it is full`,
          []
        );
      }
    }
  }

  return pass;
}

export interface EditCheckInput {
  /** The values the patch would be changing *from* — a card's, or the defaults at creation. */
  readonly current: { readonly priority: Priority; readonly classOfService: ClassOfService };
  readonly patch: TaskPatch;
  readonly actor: Actor;
}

/**
 * Can this actor apply this patch?
 *
 * The human-only fields are priority and class of service. Everything else — assignment, tags,
 * links, scope, the card's own prose — an agent may maintain, because that is bookkeeping rather
 * than a decision about what matters. A priority is a claim on the human's attention, so an agent
 * may propose one in a comment and may not set one.
 *
 * It takes `current` rather than a whole `Task` so that **creation goes through the same gate**. The
 * first version took a `Task` and was only called from the update path, which left the front door
 * open: an agent could not change a priority and could simply create the card with one. A gate that
 * guards one road is not a gate.
 */
export function checkEdit(input: EditCheckInput): PolicyResult {
  const { patch, actor, current } = input;

  if (isHuman(actor)) return pass;

  if (patch.priority !== undefined && patch.priority !== current.priority) {
    return fail(
      'human-only',
      `priority is the human's to set: ${current.priority} would become ${patch.priority}. Propose it in a comment instead`
    );
  }

  if (patch.classOfService !== undefined && patch.classOfService !== current.classOfService) {
    return fail(
      'human-only',
      `class of service is the human's to set: ${current.classOfService} would become ${patch.classOfService}`
    );
  }

  return pass;
}

/** Validate a priority string that arrived from outside TypeScript. */
export function isPriority(value: string): value is Priority {
  return (PRIORITIES as readonly string[]).includes(value);
}

/** Validate a class of service that arrived from outside TypeScript. */
export function isClassOfService(value: string): value is ClassOfService {
  return (['expedite', 'fixed-date', 'standard', 'intangible'] as readonly string[]).includes(value);
}
