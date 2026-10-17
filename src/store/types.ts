/**
 * The task vocabulary and the wire shapes the host half, the browser half and the CLI all share.
 *
 * **This file must stay pure.** It has no `node:*` import and performs no I/O, because the
 * browser half imports it: restating `State`/`Priority`/`Dod` in the client bundle is exactly how
 * two vocabularies drift, and a drifting vocabulary is how a board starts disagreeing with the
 * tools that move its cards.
 *
 * The design follows two authoritative sources, and the split between them is deliberate:
 *
 * - **The Kanban Guide (May 2025)** — a Definition of Workflow with explicit *started* and
 *   *finished* points, a control on WIP, explicit per-state policy, a Service Level Expectation,
 *   and four mandatory flow metrics (WIP, throughput, work item age, cycle time).
 * - **The 2020 Scrum Guide** — the sprint as a timebox of **one month or less** with a goal, a
 *   Definition of Ready behind selection, and a Definition of Done at the finish. Kanban itself
 *   has no sprints; this board is Scrumban, and the sprint layer is optional data.
 */

/** Every state a card can occupy, in board order. */
export const STATES = ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped'] as const;
export type State = (typeof STATES)[number];

/** States that count as WIP: anything after *started* and before *finished*. */
export const WIP_STATES = ['in-progress', 'review'] as const;
export type WipState = (typeof WIP_STATES)[number];

/** Human-facing labels, so the panel, the tools and the CLI agree on one spelling. */
export const STATE_LABEL: Readonly<Record<State, string>> = {
  backlog: 'Backlog',
  ready: 'Ready',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
  dropped: 'Dropped',
};

export const PRIORITIES = ['p0-critical', 'p1-high', 'p2-normal', 'p3-low', 'p4-someday'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Ascending urgency: a lower rank sorts first. */
export const PRIORITY_RANK: Readonly<Record<Priority, number>> = {
  'p0-critical': 0,
  'p1-high': 1,
  'p2-normal': 2,
  'p3-low': 3,
  'p4-someday': 4,
};

export const PRIORITY_LABEL: Readonly<Record<Priority, string>> = {
  'p0-critical': 'P0 critical',
  'p1-high': 'P1 high',
  'p2-normal': 'P2 normal',
  'p3-low': 'P3 low',
  'p4-someday': 'P4 someday',
};

/**
 * Classes of service. `expedite` is the one accepted exception to a WIP limit, and it is
 * human-only: the guide requires any exception to controlling WIP to be explicit in the
 * Definition of Workflow, and an agent that can excuse itself is not a control.
 */
export const CLASSES_OF_SERVICE = ['expedite', 'fixed-date', 'standard', 'intangible'] as const;
export type ClassOfService = (typeof CLASSES_OF_SERVICE)[number];

export const CLASS_LABEL: Readonly<Record<ClassOfService, string>> = {
  expedite: 'Expedite',
  'fixed-date': 'Fixed date',
  standard: 'Standard',
  intangible: 'Intangible',
};

export const SPRINT_STATES = ['planning', 'active', 'closed', 'cancelled'] as const;
export type SprintState = (typeof SPRINT_STATES)[number];

/** The Scrum Guide's "one month or less", as an enforceable number. */
export const MAX_SPRINT_DAYS = 31;

export const ACTOR_KINDS = ['human', 'agent', 'cli', 'plugin'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Who performed a mutation. `id` is a session id for an agent, or the tool's own name. */
export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
}

export const HUMAN: Actor = { kind: 'human', id: 'dhira' };

/** One completed checklist item. Absence of a key means "not yet checked". */
export interface Check {
  readonly at: string;
  readonly by: string;
}

/** Definition of Ready — what must be true before an item may leave `backlog`. */
export const DOR_CHECKS = ['outcome', 'acceptance', 'write-scope', 'estimate'] as const;

/** Definition of Done — what must be true before an item may enter `done`. */
export const DOD_CHECKS = ['evidence', 'tests-or-na', 'docs-or-lesson', 'links-resolve', 'no-unverified-claims'] as const;

export type CheckId = (typeof DOR_CHECKS)[number] | (typeof DOD_CHECKS)[number];

export const CHECK_LABEL: Readonly<Record<CheckId, string>> = {
  outcome: 'One-line outcome written',
  acceptance: 'Acceptance criteria written',
  'write-scope': 'Write scope named (or explicitly none)',
  estimate: 'Size estimated',
  evidence: 'Evidence attached (command output, test result, screenshot)',
  'tests-or-na': 'Tests pass, or "not applicable" with a reason',
  'docs-or-lesson': 'Docs updated, or the lesson recorded',
  'links-resolve': 'Every link in the card resolves',
  'no-unverified-claims': 'Nothing claimed that was not verified',
};

/** A recorded exception to a gate. The guide: exceptions must be explicit, so they are data. */
export interface GateException {
  readonly at: string;
  readonly by: string;
  readonly gate: 'dor' | 'dod' | 'wip' | 'transition';
  readonly reason: string;
}

export type LinkKind = 'file' | 'url' | 'session';

/** A pointer out of a card: a repository file, a URL, or a DSH session. */
export interface Link {
  readonly kind: LinkKind;
  readonly ref: string;
  readonly label?: string;
}

/** One card. */
export interface Task {
  readonly id: string;
  readonly title: string;
  readonly outcome: string | null;
  readonly description: string | null;
  readonly acceptance: string | null;
  readonly state: State;
  readonly priority: Priority;
  readonly classOfService: ClassOfService;
  readonly blockedReason: string | null;
  /** Required on `dropped`, enforced in SQL: an abandoned item must say why. */
  readonly droppedReason: string | null;
  readonly assignee: string | null;
  readonly project: string | null;
  readonly workspace: string | null;
  readonly sprintId: string | null;
  readonly estimate: number | null;
  readonly due: string | null;
  readonly tags: readonly string[];
  readonly links: readonly Link[];
  /**
   * The workspace-relative file or directory prefixes this card will write — the fact the DoR's
   * `write-scope` item names. The same shape the Agent Teams board's `write_scopes` carries, so a
   * scope means one thing in this home. Empty means "not recorded", which is what the gate refuses.
   */
  readonly writeScopes: readonly string[];
  readonly folder: string | null;
  readonly parentId: string | null;
  readonly position: number;
  readonly rev: number;
  readonly dor: Readonly<Partial<Record<CheckId, Check>>>;
  readonly dod: Readonly<Partial<Record<CheckId, Check>>>;
  readonly exceptions: readonly GateException[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set the first time the card enters a WIP state; the start of work item age. */
  readonly startedAt: string | null;
  /** Set the first time the card enters `done`; the end of cycle time. */
  readonly finishedAt: string | null;
  readonly createdBy: string;
  readonly updatedBy: string;
}

export const EVENT_KINDS = [
  'created',
  'updated',
  'moved',
  'blocked',
  'unblocked',
  'dropped',
  'purged',
  'commented',
  'exception',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** One append-only mutation record. The flow metrics are recomputable from these. */
export interface TaskEvent {
  readonly id: number;
  readonly at: string;
  readonly actor: string;
  readonly taskId: string;
  readonly kind: EventKind;
  readonly fromState: State | null;
  readonly toState: State | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface Sprint {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly start: string;
  readonly end: string;
  readonly state: SprintState;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

/** A task blueprint: the fields a new card starts from. */
export interface Template {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly patch: Readonly<Partial<CreateTaskInput>>;
  readonly orderIndex: number;
}

/** A saved filter, so "my view" is data rather than a habit. */
export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly filter: TaskFilter;
  readonly groupBy: 'state' | 'project' | 'assignee' | 'sprint' | 'priority';
  readonly orderIndex: number;
}

export interface Comment {
  readonly id: number;
  readonly taskId: string;
  readonly at: string;
  readonly actor: string;
  readonly body: string;
}

/**
 * The Definition of Workflow, as data.
 *
 * The guide requires the board to state the work items, the started and finished points, the
 * states, how WIP is controlled, the per-state policy and the SLE. Storing it makes the policy
 * engine's rules inspectable and printable instead of folklore.
 */
export interface DefinitionOfWorkflow {
  readonly wip: Readonly<Record<WipState, number>>;
  readonly readyCap: number;
  readonly sle: { readonly p: number; readonly days: number; readonly source: 'history' | 'guess' };
  readonly policies: Readonly<Record<State, string>>;
  readonly dor: readonly CheckId[];
  readonly dod: readonly CheckId[];
}

export const DEFAULT_DOW: DefinitionOfWorkflow = {
  wip: { 'in-progress': 2, review: 1 },
  readyCap: 5,
  sle: { p: 0.85, days: 3, source: 'guess' },
  policies: {
    backlog:
      'Anything not yet refined. Order is the only commitment. An item may not leave backlog until every DoR check is ticked.',
    ready:
      'Refined enough to be selected: outcome, acceptance criteria, write scope and size are known. Bounded at the ready cap so the queue cannot become a second backlog.',
    'in-progress':
      'Work has started — this is the started point, and where work item age and cycle time begin. Capped at the WIP limit; pull only when capacity frees.',
    review:
      'Finished by the owner, not yet accepted. Counts as WIP. Capped so review cannot become a parking lot.',
    done: 'Meets every DoD check and is finished — this is the finished point. Unfinished work returns to backlog, as the Scrum Guide requires.',
    dropped: 'Deliberately abandoned, with a reason. Kept rather than deleted so throughput and cycle time stay honest.',
  },
  dor: DOR_CHECKS,
  dod: DOD_CHECKS,
};

/** The filter a listing call takes. Every field is optional and they intersect. */
export interface TaskFilter {
  readonly state?: readonly State[];
  readonly priority?: readonly Priority[];
  readonly classOfService?: readonly ClassOfService[];
  readonly assignee?: string;
  readonly project?: string;
  readonly workspace?: string;
  readonly sprintId?: string | null;
  readonly tag?: string;
  readonly blocked?: boolean;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CreateTaskInput {
  readonly id?: string;
  readonly title: string;
  readonly outcome?: string | null;
  readonly description?: string | null;
  readonly acceptance?: string | null;
  readonly state?: State;
  readonly priority?: Priority;
  readonly classOfService?: ClassOfService;
  readonly assignee?: string | null;
  readonly project?: string | null;
  readonly workspace?: string | null;
  readonly sprintId?: string | null;
  readonly estimate?: number | null;
  readonly due?: string | null;
  readonly tags?: readonly string[];
  readonly links?: readonly Link[];
  /** A single prefix or a list of them; normalized and validated at the store. */
  readonly writeScopes?: readonly string[] | string | null;
  readonly folder?: string | null;
  readonly parentId?: string | null;
  readonly position?: number;
  /**
   * Definition of Ready checks to tick at creation, for a template or an import that already
   * knows they hold. Ticking a check is never gated, so this grants nothing a caller could not do
   * a moment later — it just avoids two transactions for a card being imported.
   */
  readonly dor?: readonly CheckId[];
}

/** A partial edit. `undefined` leaves a field alone; `null` clears it. */
export interface TaskPatch {
  readonly title?: string;
  readonly outcome?: string | null;
  readonly description?: string | null;
  readonly acceptance?: string | null;
  readonly priority?: Priority;
  readonly classOfService?: ClassOfService;
  readonly assignee?: string | null;
  readonly project?: string | null;
  readonly workspace?: string | null;
  readonly sprintId?: string | null;
  readonly estimate?: number | null;
  readonly due?: string | null;
  readonly tags?: readonly string[];
  readonly links?: readonly Link[];
  /** `[]` or `null` clears the recorded scope; the `write-scope` DoR item then needs a tick again. */
  readonly writeScopes?: readonly string[] | string | null;
  readonly folder?: string | null;
}

export interface MoveInput {
  readonly id: string;
  readonly toState: State;
  readonly toPosition?: number;
  readonly expectedRev?: number;
  readonly force?: boolean;
  readonly reason?: string;
}

/**
 * Board order inside one column.
 *
 * **Position is the truth, and priority is a badge.** A drag-and-drop board is an ordering device:
 * if priority outranked position, dragging a P0 to the top of a column would silently do nothing,
 * which is the kind of lie a board cannot afford. So the order is:
 *
 * 1. `expedite` first — the class of service is the one accepted exception to WIP control, and an
 *    exception nobody can see is not a control;
 * 2. then the hand-set `position`, which is what dragging writes;
 * 3. then priority rank, so a fresh card with no explicit position still lands sensibly;
 * 4. then `id`, so the order is total and the generated Markdown is byte-stable.
 *
 * Sorting a column *by priority* is a view-level choice, not the storage order.
 */
export function compareInColumn(a: Task, b: Task): number {
  const aExp = a.classOfService === 'expedite' ? 0 : 1;
  const bExp = b.classOfService === 'expedite' ? 0 : 1;
  if (aExp !== bExp) return aExp - bExp;
  if (a.position !== b.position) return a.position - b.position;
  const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (rank !== 0) return rank;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Board order across columns: the state order above. */
export function stateIndex(state: State): number {
  return STATES.indexOf(state);
}
