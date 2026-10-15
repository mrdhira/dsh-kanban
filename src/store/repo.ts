/**
 * The repository: every mutation, each one transaction that writes the row **and** its event.
 *
 * The event log is not decoration. It is what makes the flow metrics auditable — cycle time can be
 * recomputed from `events` and compared against the columns, so a card whose `started_at` was set
 * without a matching move is detectable rather than invisible. That is why the write and the event
 * are in the same transaction: a board that moves a card but forgets to record it is a board whose
 * numbers lie.
 *
 * Two invariants are enforced here rather than trusted:
 *
 * - **Creation starts in `backlog`.** Work emerges there. Any other starting state would be a way
 *   to bypass the Definition of Ready, so `createTask` refuses it and points at `moveTask`. The
 *   one caller allowed to place a card elsewhere is the importer (`importTask`), which is how the
 *   existing board is migrated once.
 * - **`rev` is checked, never assumed.** A write carrying `expectedRev` that no longer matches
 *   throws `ConflictError` with the current row attached, so a UI rebases instead of overwriting
 *   whatever landed first.
 */
import {
  bumpBoardRev,
  execute,
  nextPosition,
  query,
  queryOne,
  readBoardRev,
  readDow,
  withWrite,
  type Board,
  type SqlValue,
} from './db.js';
import { ConflictError, InvalidError, NotFoundError, PolicyViolation } from './errors.js';
import {
  actorId,
  checkEdit,
  checkMove,
  checkSprintWindow,
  isClassOfService,
  isPriority,
  isWip,
} from './policy.js';
import { isSprintState } from './schema.js';
import {
  DOD_CHECKS,
  DOR_CHECKS,
  STATES,
  WIP_STATES,
  type Actor,
  type Check,
  type CheckId,
  type ClassOfService,
  type Comment,
  type CreateTaskInput,
  type EventKind,
  type GateException,
  type Link,
  type MoveInput,
  type Priority,
  type SavedView,
  type Sprint,
  type State,
  type Task,
  type TaskEvent,
  type TaskFilter,
  type TaskPatch,
  type Template,
} from './types.js';

/** Every mutation takes the actor and, for determinism, the clock. */
export interface MutationOptions {
  readonly actor: Actor;
  readonly now?: Date;
}

function nowIso(options: MutationOptions): string {
  return (options.now ?? new Date()).toISOString();
}

// --------------------------------------------------------------------------- rows

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly outcome: string | null;
  readonly description: string | null;
  readonly acceptance: string | null;
  readonly state: string;
  readonly priority: string;
  readonly class_of_service: string;
  readonly blocked_reason: string | null;
  readonly dropped_reason: string | null;
  readonly assignee: string | null;
  readonly project: string | null;
  readonly workspace: string | null;
  readonly sprint_id: string | null;
  readonly estimate: number | null;
  readonly due: string | null;
  readonly tags: string;
  readonly links: string;
  readonly folder: string | null;
  readonly parent_id: string | null;
  readonly position: number;
  readonly rev: number;
  readonly dor: string;
  readonly dod: string;
  readonly exceptions: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly created_by: string;
  readonly updated_by: string;
}

/** JSON columns tolerated on read: a hand-edited board must not take the whole page down. */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    const value = JSON.parse(raw) as unknown;
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

const TASK_COLUMNS = `id, title, outcome, description, acceptance, state, priority, class_of_service,
  blocked_reason, dropped_reason, assignee, project, workspace, sprint_id, estimate, due, tags, links,
  folder, parent_id, position, rev, dor, dod, exceptions, created_at, updated_at, started_at, finished_at,
  created_by, updated_by`;

function toTask(row: TaskRow): Task {
  if (!(STATES as readonly string[]).includes(row.state)) {
    throw new InvalidError(`task ${row.id} has an unknown state ${JSON.stringify(row.state)}`);
  }
  const state = row.state as State;
  if (!isPriority(row.priority)) {
    throw new InvalidError(`task ${row.id} has an unknown priority ${JSON.stringify(row.priority)}`);
  }
  if (!isClassOfService(row.class_of_service)) {
    throw new InvalidError(`task ${row.id} has an unknown class of service ${JSON.stringify(row.class_of_service)}`);
  }
  return {
    id: row.id,
    title: row.title,
    outcome: row.outcome,
    description: row.description,
    acceptance: row.acceptance,
    state,
    priority: row.priority,
    classOfService: row.class_of_service,
    blockedReason: row.blocked_reason,
    droppedReason: row.dropped_reason,
    assignee: row.assignee,
    project: row.project,
    workspace: row.workspace,
    sprintId: row.sprint_id,
    estimate: row.estimate,
    due: row.due,
    tags: parseJson<readonly string[]>(row.tags, []),
    links: parseJson<readonly Link[]>(row.links, []),
    folder: row.folder,
    parentId: row.parent_id,
    position: row.position,
    rev: row.rev,
    dor: parseJson<Readonly<Partial<Record<CheckId, Check>>>>(row.dor, {}),
    dod: parseJson<Readonly<Partial<Record<CheckId, Check>>>>(row.dod, {}),
    exceptions: parseJson<readonly GateException[]>(row.exceptions, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

// --------------------------------------------------------------------------- reads

/** A listing plus the rows that failed validation, so nothing is skipped in silence. */
export interface TaskList {
  readonly tasks: readonly Task[];
  readonly total: number;
  readonly invalid: readonly { readonly id: string; readonly reason: string }[];
}

export function getTask(board: Board, id: string): Task | undefined {
  const row = queryOne<TaskRow>(board, `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`, [id]);
  return row === undefined ? undefined : toTask(row);
}

export function getTaskOrThrow(board: Board, id: string): Task {
  const task = getTask(board, id);
  if (task === undefined) throw new NotFoundError('task', id);
  return task;
}

export function countsByState(board: Board): Record<string, number> {
  const rows = query<{ state: string; count: number }>(
    board,
    'SELECT state, count(*) AS count FROM tasks GROUP BY state'
  );
  const out: Record<string, number> = {};
  for (const state of STATES) out[state] = 0;
  for (const row of rows) out[row.state] = row.count;
  return out;
}

function buildFilter(filter: TaskFilter | undefined): { where: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  if (filter?.state !== undefined && filter.state.length > 0) {
    clauses.push(`state IN (${filter.state.map(() => '?').join(', ')})`);
    params.push(...filter.state);
  }
  if (filter?.priority !== undefined && filter.priority.length > 0) {
    clauses.push(`priority IN (${filter.priority.map(() => '?').join(', ')})`);
    params.push(...filter.priority);
  }
  if (filter?.classOfService !== undefined && filter.classOfService.length > 0) {
    clauses.push(`class_of_service IN (${filter.classOfService.map(() => '?').join(', ')})`);
    params.push(...filter.classOfService);
  }
  if (filter?.assignee !== undefined) {
    clauses.push('assignee = ?');
    params.push(filter.assignee);
  }
  if (filter?.project !== undefined) {
    clauses.push('project = ?');
    params.push(filter.project);
  }
  if (filter?.workspace !== undefined) {
    clauses.push('workspace = ?');
    params.push(filter.workspace);
  }
  if (filter?.sprintId !== undefined) {
    if (filter.sprintId === null) {
      clauses.push('sprint_id IS NULL');
    } else {
      clauses.push('sprint_id = ?');
      params.push(filter.sprintId);
    }
  }
  if (filter?.blocked !== undefined) {
    clauses.push(filter.blocked ? 'blocked_reason IS NOT NULL' : 'blocked_reason IS NULL');
  }
  if (filter?.tag !== undefined) {
    clauses.push("tags LIKE ?");
    params.push(`%"${filter.tag}"%`);
  }
  if (filter?.search !== undefined && filter.search.trim().length > 0) {
    const needle = `%${filter.search.trim()}%`;
    clauses.push('(title LIKE ? OR outcome LIKE ? OR description LIKE ? OR id LIKE ?)');
    params.push(needle, needle, needle, needle);
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function listTasks(board: Board, filter?: TaskFilter): TaskList {
  const { where, params } = buildFilter(filter);
  const totalRow = queryOne<{ total: number }>(board, `SELECT count(*) AS total FROM tasks ${where}`, params);
  const limit = Math.min(Math.max(filter?.limit ?? 200, 1), 500);
  const offset = Math.max(filter?.offset ?? 0, 0);

  const rows = query<TaskRow>(
    board,
    `SELECT ${TASK_COLUMNS} FROM tasks ${where} ORDER BY id LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const tasks: Task[] = [];
  const invalid: { id: string; reason: string }[] = [];
  for (const row of rows) {
    try {
      tasks.push(toTask(row));
    } catch (error) {
      invalid.push({ id: row.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { tasks, total: totalRow?.total ?? tasks.length, invalid };
}

export function listEvents(
  board: Board,
  options: { taskId?: string; limit?: number } = {}
): TaskEvent[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const rows =
    options.taskId === undefined
      ? query<{
          id: number;
          at: string;
          actor: string;
          task_id: string;
          kind: string;
          from_state: string | null;
          to_state: string | null;
          payload: string;
        }>(board, 'SELECT * FROM events ORDER BY id DESC LIMIT ?', [limit])
      : query<{
          id: number;
          at: string;
          actor: string;
          task_id: string;
          kind: string;
          from_state: string | null;
          to_state: string | null;
          payload: string;
        }>(board, 'SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?', [options.taskId, limit]);

  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    actor: row.actor,
    taskId: row.task_id,
    kind: row.kind as EventKind,
    fromState: row.from_state as State | null,
    toState: row.to_state as State | null,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
  }));
}

/** The observations the metrics cross-check recomputes cycle time from. */
export function moveObservations(board: Board): {
  taskId: string;
  at: string;
  fromState: State | null;
  toState: State | null;
  kind: string;
}[] {
  return query<{ task_id: string; at: string; from_state: string | null; to_state: string | null; kind: string }>(
    board,
    "SELECT task_id, at, from_state, to_state, kind FROM events WHERE kind = 'moved' ORDER BY id",
    []
  ).map((row) => ({
    taskId: row.task_id,
    at: row.at,
    fromState: row.from_state as State | null,
    toState: row.to_state as State | null,
    kind: row.kind,
  }));
}

// --------------------------------------------------------------------------- ids

/** `T-###` — the next free number, so ids stay human-readable and stable forever. */
export function generateTaskId(board: Board): string {
  const rows = query<{ id: string }>(board, "SELECT id FROM tasks WHERE id LIKE 'T-%'", []);
  let max = 0;
  for (const row of rows) {
    const match = /^T-(\d+)$/.exec(row.id);
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
  }
  return `T-${String(max + 1).padStart(3, '0')}`;
}

function generateSprintId(board: Board): string {
  const rows = query<{ id: string }>(board, "SELECT id FROM sprints WHERE id LIKE 'S-%'", []);
  let max = 0;
  for (const row of rows) {
    const match = /^S-(\d+)$/.exec(row.id);
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
  }
  return `S-${String(max + 1).padStart(3, '0')}`;
}

// --------------------------------------------------------------------------- events

function appendEvent(
  board: Board,
  input: {
    readonly at: string;
    readonly actor: string;
    readonly taskId: string;
    readonly kind: EventKind;
    readonly fromState: State | null;
    readonly toState: State | null;
    readonly payload?: Record<string, unknown>;
  }
): void {
  execute(
    board,
    'INSERT INTO events (at, actor, task_id, kind, from_state, to_state, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      input.at,
      input.actor,
      input.taskId,
      input.kind,
      input.fromState,
      input.toState,
      JSON.stringify(input.payload ?? {}),
    ]
  );
}

// --------------------------------------------------------------------------- writes

interface InsertInput extends CreateTaskInput {
  readonly state: State;
  readonly priority: Priority;
  readonly classOfService: ClassOfService;
}

/**
 * The raw insert, with no gate. Its only unguarded caller is the importer.
 *
 * It still writes a `created` event: a migrated row is as much a subject of the metrics as a new
 * one.
 */
function insertTask(board: Board, input: InsertInput, options: MutationOptions): Task {
  const at = nowIso(options);
  const by = actorId(options.actor);
  const state = input.state;
  const started = (WIP_STATES as readonly string[]).includes(state) || state === 'done' ? at : null;
  const finished = state === 'done' ? at : null;
  const dorChecks: Record<string, Check> = {};
  for (const checkId of input.dor ?? []) dorChecks[checkId] = { at, by };

  execute(
    board,
    `INSERT INTO tasks (id, title, outcome, description, acceptance, state, priority, class_of_service,
      blocked_reason, dropped_reason, assignee, project, workspace, sprint_id, estimate, due, tags, links,
      folder, parent_id, position, rev, dor, dod, exceptions, created_at, updated_at, started_at, finished_at,
      created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '{}', '[]', ?, ?, ?, ?, ?, ?)`,
    [
      input.id as string,
      input.title.trim(),
      input.outcome ?? null,
      input.description ?? null,
      input.acceptance ?? null,
      state,
      input.priority,
      input.classOfService,
      state === 'dropped' ? (input.description ?? 'imported as dropped') : null,
      input.assignee ?? null,
      input.project ?? null,
      input.workspace ?? null,
      input.sprintId ?? null,
      input.estimate ?? null,
      input.due ?? null,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.links ?? []),
      input.folder ?? null,
      input.parentId ?? null,
      input.position ?? nextPosition(board, state),
      JSON.stringify(dorChecks),
      at,
      at,
      started,
      finished,
      by,
      by,
    ]
  );

  appendEvent(board, {
    at,
    actor: by,
    taskId: input.id as string,
    kind: 'created',
    fromState: null,
    toState: state,
    payload: { title: input.title.trim() },
  });

  bumpBoardRev(board);
  return getTaskOrThrow(board, input.id as string);
}

export interface CreateOptions extends MutationOptions {
  /** Allows the importer (and only the importer) to place a card outside `backlog`. */
  readonly imported?: boolean;
}

/**
 * Create a card. It starts in `backlog`; move it to start it.
 *
 * The refusal is deliberate and permanent rather than a missing feature: a `create` that could
 * skip the gates would make every gate optional, and the Definition of Ready is only a control if
 * it sits in front of the road everyone uses.
 */
export function createTask(board: Board, input: CreateTaskInput, options: CreateOptions): Task {
  if (input.title.trim().length === 0) throw new InvalidError('a task needs a non-empty title');
  const priority = input.priority ?? 'p2-normal';
  const classOfService = input.classOfService ?? 'standard';
  if (!isPriority(priority)) throw new InvalidError(`unknown priority ${JSON.stringify(priority)}`);
  if (!isClassOfService(classOfService)) throw new InvalidError(`unknown class of service ${JSON.stringify(classOfService)}`);
  if (input.classOfService === 'expedite' && options.actor.kind !== 'human') {
    throw new InvalidError('only the human may create an expedite card');
  }

  const requestedState = input.state ?? 'backlog';
  if (!(STATES as readonly string[]).includes(requestedState)) {
    throw new InvalidError(`unknown state ${JSON.stringify(requestedState)}`);
  }
  if (requestedState !== 'backlog' && options.imported !== true) {
    throw new InvalidError(
      `a new card starts in backlog, not ${requestedState}; create it and then move it so the Definition of Ready and the WIP limits apply`
    );
  }

  return withWrite(board, () => {
    const id = input.id ?? generateTaskId(board);
    if (queryOne<{ id: string }>(board, 'SELECT id FROM tasks WHERE id = ?', [id]) !== undefined) {
      throw new InvalidError(`task ${JSON.stringify(id)} already exists`);
    }
    return insertTask(
      board,
      { ...input, id, state: requestedState, priority, classOfService },
      options
    );
  });
}

/** The importer's entry point: no gate, but still an event and still transactional. */
export function importTask(board: Board, input: CreateTaskInput, options: CreateOptions): Task {
  return createTask(board, input, { ...options, imported: true });
}

/** Encode one editable patch field into a bindable column value. */
interface EditableField {
  readonly key: keyof TaskPatch;
  readonly column: string;
  readonly encode: (value: unknown) => SqlValue;
}

const EDITABLE: readonly EditableField[] = [
  { key: 'title', column: 'title', encode: (v) => String(v).trim() },
  { key: 'outcome', column: 'outcome', encode: (v) => (v === null ? null : String(v)) },
  { key: 'description', column: 'description', encode: (v) => (v === null ? null : String(v)) },
  { key: 'acceptance', column: 'acceptance', encode: (v) => (v === null ? null : String(v)) },
  { key: 'priority', column: 'priority', encode: (v) => String(v) },
  { key: 'classOfService', column: 'class_of_service', encode: (v) => String(v) },
  { key: 'assignee', column: 'assignee', encode: (v) => (v === null ? null : String(v)) },
  { key: 'project', column: 'project', encode: (v) => (v === null ? null : String(v)) },
  { key: 'workspace', column: 'workspace', encode: (v) => (v === null ? null : String(v)) },
  { key: 'sprintId', column: 'sprint_id', encode: (v) => (v === null ? null : String(v)) },
  { key: 'estimate', column: 'estimate', encode: (v) => (v === null ? null : Number(v)) },
  { key: 'due', column: 'due', encode: (v) => (v === null ? null : String(v)) },
  { key: 'tags', column: 'tags', encode: (v) => JSON.stringify(v ?? []) },
  { key: 'links', column: 'links', encode: (v) => JSON.stringify(v ?? []) },
  { key: 'folder', column: 'folder', encode: (v) => (v === null ? null : String(v)) },
];

export interface UpdateOptions extends MutationOptions {
  readonly expectedRev?: number;
}

export function updateTask(board: Board, id: string, patch: TaskPatch, options: UpdateOptions): Task {
  return withWrite(board, () => {
    const current = getTaskOrThrow(board, id);
    if (options.expectedRev !== undefined && options.expectedRev !== current.rev) {
      throw new ConflictError('task', id, current);
    }

    const verdict = checkEdit({ task: current, patch, actor: options.actor });
    if (!verdict.ok) throw new PolicyViolation(verdict);

    if (patch.title !== undefined && patch.title.trim().length === 0) {
      throw new InvalidError('a task needs a non-empty title');
    }
    if (patch.priority !== undefined && !isPriority(patch.priority)) {
      throw new InvalidError(`unknown priority ${JSON.stringify(patch.priority)}`);
    }
    if (patch.classOfService !== undefined && !isClassOfService(patch.classOfService)) {
      throw new InvalidError(`unknown class of service ${JSON.stringify(patch.classOfService)}`);
    }
    if (patch.estimate !== undefined && patch.estimate !== null && !Number.isFinite(patch.estimate)) {
      throw new InvalidError('estimate must be a finite number');
    }

    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const field of EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(patch, field.key)) {
        sets.push(`${field.column} = ?`);
        params.push(field.encode((patch as Record<string, unknown>)[field.key]));
      }
    }

    const at = nowIso(options);
    const by = actorId(options.actor);
    if (sets.length > 0) {
      execute(
        board,
        `UPDATE tasks SET ${sets.join(', ')}, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
        [...params, at, by, id]
      );
      appendEvent(board, {
        at,
        actor: by,
        taskId: id,
        kind: 'updated',
        fromState: current.state,
        toState: current.state,
        payload: { fields: Object.keys(patch) },
      });
      bumpBoardRev(board);
    }

    return getTaskOrThrow(board, id);
  });
}

/**
 * Move a card. The one place `started_at` and `finished_at` are written.
 *
 * Positions: omitting `toPosition` appends to the target column, which is what a drop onto a
 * column's empty space means.
 */
export function moveTask(board: Board, input: MoveInput, options: MutationOptions): Task {
  return withWrite(board, () => {
    const current = getTaskOrThrow(board, input.id);
    if (input.expectedRev !== undefined && input.expectedRev !== current.rev) {
      throw new ConflictError('task', input.id, current);
    }
    if (!(STATES as readonly string[]).includes(input.toState)) {
      throw new InvalidError(`unknown state ${JSON.stringify(input.toState)}`);
    }

    const counts = countsByState(board);
    const verdict = checkMove({
      task: current,
      toState: input.toState,
      dow: readDow(board),
      counts,
      actor: options.actor,
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    if (!verdict.ok) throw new PolicyViolation(verdict);

    const at = nowIso(options);
    const by = actorId(options.actor);
    const position = input.toPosition ?? nextPosition(board, input.toState);

    const started = current.startedAt;
    const nextStarted =
      started ?? ((WIP_STATES as readonly string[]).includes(input.toState) || input.toState === 'done' ? at : null);
    const nextFinished =
      input.toState === 'done' ? (current.finishedAt ?? at) : input.toState === 'dropped' ? current.finishedAt : null;
    const droppedReason = input.toState === 'dropped' ? (input.reason ?? null) : null;

    // A forced move records its exception on the card, because the guide requires an exception to
    // be visible in the Definition of Workflow rather than a thing that quietly happened once.
    const exceptions: GateException[] =
      input.force === true && input.reason !== undefined
        ? [
            ...current.exceptions,
            { at, by, gate: gateForMove(current, input), reason: input.reason },
          ]
        : [...current.exceptions];

    execute(
      board,
      `UPDATE tasks SET state = ?, position = ?, rev = rev + 1, updated_at = ?, updated_by = ?,
        started_at = ?, finished_at = ?, dropped_reason = ?, exceptions = ? WHERE id = ?`,
      [
        input.toState,
        position,
        at,
        by,
        nextStarted,
        nextFinished,
        droppedReason,
        JSON.stringify(exceptions),
        input.id,
      ]
    );

    appendEvent(board, {
      at,
      actor: by,
      taskId: input.id,
      kind: 'moved',
      fromState: current.state,
      toState: input.toState,
      payload:
        input.reason === undefined
          ? { position }
          : { position, reason: input.reason, forced: input.force === true },
    });

    if (exceptions.length !== current.exceptions.length) {
      appendEvent(board, {
        at,
        actor: by,
        taskId: input.id,
        kind: 'exception',
        fromState: current.state,
        toState: input.toState,
        payload: { reason: input.reason ?? '' },
      });
    }

    bumpBoardRev(board);
    return getTaskOrThrow(board, input.id);
  });
}

/**
 * Which gate a forced move excepted, recorded on the card.
 *
 * The order mirrors `checkMove`: the Definition of Done guards `done`, the Definition of Ready
 * guards every exit from the backlog except dropping, and everything else is WIP or queue control.
 */
function gateForMove(current: Task, input: MoveInput): GateException['gate'] {
  if (input.toState === 'done') return 'dod';
  if (current.state === 'backlog' && input.toState !== 'dropped') return 'dor';
  if (isWip(input.toState) || input.toState === 'ready') return 'wip';
  return 'transition';
}

export function blockTask(board: Board, id: string, reason: string, options: MutationOptions): Task {
  if (reason.trim().length === 0) throw new InvalidError('a blocker needs a reason');
  return withWrite(board, () => {
    const current = getTaskOrThrow(board, id);
    const at = nowIso(options);
    const by = actorId(options.actor);
    execute(board, 'UPDATE tasks SET blocked_reason = ?, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ?', [
      reason.trim(),
      at,
      by,
      id,
    ]);
    appendEvent(board, {
      at,
      actor: by,
      taskId: id,
      kind: 'blocked',
      fromState: current.state,
      toState: current.state,
      payload: { reason: reason.trim() },
    });
    bumpBoardRev(board);
    return getTaskOrThrow(board, id);
  });
}

export function unblockTask(board: Board, id: string, options: MutationOptions): Task {
  return withWrite(board, () => {
    const current = getTaskOrThrow(board, id);
    const at = nowIso(options);
    const by = actorId(options.actor);
    execute(board, 'UPDATE tasks SET blocked_reason = NULL, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ?', [
      at,
      by,
      id,
    ]);
    appendEvent(board, {
      at,
      actor: by,
      taskId: id,
      kind: 'unblocked',
      fromState: current.state,
      toState: current.state,
      payload: {},
    });
    bumpBoardRev(board);
    return getTaskOrThrow(board, id);
  });
}

/** Tick or untick one Definition of Ready / Done check. */
export function setCheck(
  board: Board,
  id: string,
  gate: 'dor' | 'dod',
  checkId: string,
  done: boolean,
  options: MutationOptions
): Task {
  const allowed: readonly string[] = gate === 'dor' ? DOR_CHECKS : DOD_CHECKS;
  if (!allowed.includes(checkId)) {
    throw new InvalidError(`${JSON.stringify(checkId)} is not a ${gate.toUpperCase()} check`);
  }

  return withWrite(board, () => {
    const current = getTaskOrThrow(board, id);
    const at = nowIso(options);
    const by = actorId(options.actor);
    const checks: Record<string, unknown> = { ...(gate === 'dor' ? current.dor : current.dod) };
    if (done) {
      checks[checkId] = { at, by };
    } else {
      delete checks[checkId];
    }
    const column = gate === 'dor' ? 'dor' : 'dod';
    execute(board, `UPDATE tasks SET ${column} = ?, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ?`, [
      JSON.stringify(checks),
      at,
      by,
      id,
    ]);
    appendEvent(board, {
      at,
      actor: by,
      taskId: id,
      kind: 'updated',
      fromState: current.state,
      toState: current.state,
      payload: { gate, check: checkId, done },
    });
    bumpBoardRev(board);
    return getTaskOrThrow(board, id);
  });
}

/** Hard delete. Human-only, and it still leaves a `purged` event behind. */
export function purgeTask(board: Board, id: string, options: MutationOptions): void {
  if (options.actor.kind !== 'human') {
    throw new InvalidError('only the human may hard-delete a card; use drop so the metrics stay honest');
  }
  withWrite(board, () => {
    const current = getTaskOrThrow(board, id);
    const at = nowIso(options);
    appendEvent(board, {
      at,
      actor: actorId(options.actor),
      taskId: id,
      kind: 'purged',
      fromState: current.state,
      toState: null,
      payload: { title: current.title },
    });
    execute(board, 'DELETE FROM tasks WHERE id = ?', [id]);
    bumpBoardRev(board);
  });
}

export function addComment(board: Board, taskId: string, body: string, options: MutationOptions): Comment {
  if (body.trim().length === 0) throw new InvalidError('a comment needs a body');
  return withWrite(board, () => {
    const current = getTaskOrThrow(board, taskId);
    const at = nowIso(options);
    const by = actorId(options.actor);
    execute(board, 'INSERT INTO comments (task_id, at, actor, body) VALUES (?, ?, ?, ?)', [
      taskId,
      at,
      by,
      body.trim(),
    ]);
    appendEvent(board, {
      at,
      actor: by,
      taskId,
      kind: 'commented',
      fromState: current.state,
      toState: current.state,
      payload: { body: body.trim() },
    });
    bumpBoardRev(board);
    const row = queryOne<{ id: number }>(board, 'SELECT last_insert_rowid() AS id', []);
    return { id: row?.id ?? 0, taskId, at, actor: by, body: body.trim() };
  });
}

export function listComments(board: Board, taskId: string): Comment[] {
  return query<{ id: number; task_id: string; at: string; actor: string; body: string }>(
    board,
    'SELECT id, task_id, at, actor, body FROM comments WHERE task_id = ? ORDER BY id',
    [taskId]
  ).map((row) => ({ id: row.id, taskId: row.task_id, at: row.at, actor: row.actor, body: row.body }));
}

// --------------------------------------------------------------------------- sprints

interface SprintRow {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly start: string;
  readonly end: string;
  readonly state: string;
  readonly created_at: string;
  readonly closed_at: string | null;
}

function toSprint(row: SprintRow): Sprint {
  if (!isSprintState(row.state)) {
    throw new InvalidError(`sprint ${row.id} has an unknown state ${JSON.stringify(row.state)}`);
  }
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    start: row.start,
    end: row.end,
    state: row.state,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

export function listSprints(board: Board): Sprint[] {
  return query<SprintRow>(board, 'SELECT * FROM sprints ORDER BY start DESC').map(toSprint);
}

export function getSprint(board: Board, id: string): Sprint | undefined {
  const row = queryOne<SprintRow>(board, 'SELECT * FROM sprints WHERE id = ?', [id]);
  return row === undefined ? undefined : toSprint(row);
}

export interface CreateSprintInput {
  readonly id?: string;
  readonly name: string;
  readonly goal: string;
  readonly start: string;
  readonly end: string;
}

export function createSprint(board: Board, input: CreateSprintInput, options: MutationOptions): Sprint {
  if (input.name.trim().length === 0) throw new InvalidError('a sprint needs a name');
  const verdict = checkSprintWindow(input.start, input.end);
  if (!verdict.ok) throw new PolicyViolation(verdict);

  return withWrite(board, () => {
    const id = input.id ?? generateSprintId(board);
    execute(board, 'INSERT INTO sprints (id, name, goal, start, end, state, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', [
      id,
      input.name.trim(),
      input.goal,
      input.start,
      input.end,
      'planning',
      nowIso(options),
    ]);
    bumpBoardRev(board);
    const sprint = getSprint(board, id);
    if (sprint === undefined) throw new InvalidError('sprint insert did not persist');
    return sprint;
  });
}

/** Activate a sprint. Only one may be active: a board cannot have two goals. */
export function startSprint(board: Board, id: string, options: MutationOptions): Sprint {
  return withWrite(board, () => {
    const sprint = getSprint(board, id);
    if (sprint === undefined) throw new NotFoundError('sprint', id);
    if (sprint.state !== 'planning') throw new InvalidError(`sprint ${id} is ${sprint.state}, not planning`);

    const active = queryOne<{ id: string }>(board, "SELECT id FROM sprints WHERE state = 'active'", []);
    if (active !== undefined) throw new InvalidError(`sprint ${active.id} is already active; close it first`);

    execute(board, "UPDATE sprints SET state = 'active' WHERE id = ?", [id]);
    bumpBoardRev(board);
    return getSprint(board, id) as Sprint;
  });
}

/**
 * Close a sprint.
 *
 * Unfinished work returns to the backlog with the sprint's goal dropped, which is exactly what the
 * Scrum Guide prescribes: an item that is not Done is not an Increment, so it goes back to the
 * Product Backlog rather than being carried as if it counted.
 */
export function closeSprint(board: Board, id: string, options: MutationOptions): { sprint: Sprint; returned: readonly string[] } {
  return withWrite(board, () => {
    const sprint = getSprint(board, id);
    if (sprint === undefined) throw new NotFoundError('sprint', id);
    if (sprint.state !== 'active') throw new InvalidError(`sprint ${id} is ${sprint.state}, not active; only an active sprint can close`);

    const at = nowIso(options);
    const by = actorId(options.actor);
    const unfinished = query<{ id: string; state: string }>(
      board,
      "SELECT id, state FROM tasks WHERE sprint_id = ? AND state NOT IN ('done', 'dropped')",
      [id]
    );

    for (const row of unfinished) {
      execute(board, 'UPDATE tasks SET sprint_id = NULL, state = ?, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ?', [
        'backlog',
        at,
        by,
        row.id,
      ]);
      appendEvent(board, {
        at,
        actor: by,
        taskId: row.id,
        kind: 'moved',
        fromState: row.state as State,
        toState: 'backlog',
        payload: { reason: `sprint ${id} closed` },
      });
    }

    execute(board, "UPDATE sprints SET state = 'closed', closed_at = ? WHERE id = ?", [at, id]);
    bumpBoardRev(board);
    return { sprint: getSprint(board, id) as Sprint, returned: unfinished.map((row) => row.id) };
  });
}

/** Cancel a sprint — human-only, for the same reason the Scrum Guide gives the Product Owner. */
export function cancelSprint(board: Board, id: string, reason: string, options: MutationOptions): Sprint {
  if (options.actor.kind !== 'human') throw new InvalidError('only the human may cancel a sprint');
  if (reason.trim().length === 0) throw new InvalidError('cancelling a sprint requires a reason');
  return withWrite(board, () => {
    const sprint = getSprint(board, id);
    if (sprint === undefined) throw new NotFoundError('sprint', id);
    const at = nowIso(options);
    query<{ id: string }>(board, 'SELECT id FROM tasks WHERE sprint_id = ?', [id]).forEach((row) => {
      execute(board, 'UPDATE tasks SET sprint_id = NULL, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ?', [
        at,
        actorId(options.actor),
        row.id,
      ]);
    });
    execute(board, "UPDATE sprints SET state = 'cancelled', closed_at = ? WHERE id = ?", [at, id]);
    bumpBoardRev(board);
    return getSprint(board, id) as Sprint;
  });
}

// --------------------------------------------------------------------------- templates & views

export function listTemplates(board: Board): Template[] {
  return query<{ id: string; name: string; description: string; patch: string; order_index: number }>(
    board,
    'SELECT * FROM templates ORDER BY order_index, id'
  ).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    patch: parseJson<Partial<CreateTaskInput>>(row.patch, {}),
    orderIndex: row.order_index,
  }));
}

export function saveTemplate(
  board: Board,
  template: Omit<Template, 'orderIndex'> & { readonly orderIndex?: number },
  options: MutationOptions
): Template {
  return withWrite(board, () => {
    execute(
      board,
      `INSERT INTO templates (id, name, description, patch, order_index) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, patch = excluded.patch`,
      [
        template.id,
        template.name,
        template.description,
        JSON.stringify(template.patch),
        template.orderIndex ?? nowDate(options).getTime(),
      ]
    );
    bumpBoardRev(board);
    const found = listTemplates(board).find((entry) => entry.id === template.id);
    if (found === undefined) throw new InvalidError('template insert did not persist');
    return found;
  });
}

function nowDate(options: MutationOptions): Date {
  return options.now ?? new Date();
}

export function listViews(board: Board): SavedView[] {
  return query<{ id: string; name: string; description: string; filter: string; group_by: string; order_index: number }>(
    board,
    'SELECT * FROM views ORDER BY order_index, id'
  ).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    filter: parseJson<TaskFilter>(row.filter, {}),
    groupBy: row.group_by as SavedView['groupBy'],
    orderIndex: row.order_index,
  }));
}

export function saveView(
  board: Board,
  view: Omit<SavedView, 'orderIndex'> & { readonly orderIndex?: number },
  _options: MutationOptions
): SavedView {
  return withWrite(board, () => {
    execute(
      board,
      `INSERT INTO views (id, name, description, filter, group_by, order_index) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
         filter = excluded.filter, group_by = excluded.group_by`,
      [view.id, view.name, view.description, JSON.stringify(view.filter), view.groupBy, view.orderIndex ?? 0]
    );
    bumpBoardRev(board);
    const found = listViews(board).find((entry) => entry.id === view.id);
    if (found === undefined) throw new InvalidError('view insert did not persist');
    return found;
  });
}

export function deleteView(board: Board, id: string): void {
  withWrite(board, () => {
    if (listViews(board).every((view) => view.id !== id)) throw new NotFoundError('view', id);
    execute(board, 'DELETE FROM views WHERE id = ?', [id]);
    bumpBoardRev(board);
  });
}

/** The revision a client should have read, for its next conditional request. */
export function boardRevision(board: Board): number {
  return readBoardRev(board);
}
