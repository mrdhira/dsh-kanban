/**
 * The agent surface: nine tools over the same policy engine the panel and the CLI use.
 *
 * Definitions are plain literals, not `defineTool(...)` — that helper lives in
 * `@deepseek-ai/dsh-tools`, which a profile plugin cannot resolve. Their *shape* was copied from
 * the shipped `@deepseek-ai/dsh-tool-todo`: a `parameters` record whose members carry their own
 * `required`, an `output.schema`, and a `render` that returns content blocks.
 *
 * Two decisions worth stating:
 *
 * - **Few tools, thin wrappers.** Nine, not ninety. Each one is a small translation of arguments
 *   into a repository call, so the rules live in `policy.ts` and cannot be enforced twice with two
 *   different answers. `kanban_update` carries the cheap verbs (assign, tag, tick a check,
 *   comment, block) because they share one guard.
 * - **The actor is the session.** A tool call is attributed to `agent:<session-id>` from the run
 *   context, never to something the model wrote into its arguments. That is what makes "priority is
 *   the human's" a real rule: there is no argument an agent can pass to become the human.
 */
import type { DshJson, DshToolDefinition, DshToolRunContext } from '../types/dsh.js';
import type { Board } from '../store/db.js';
import {
  addComment,
  blockTask,
  boardRevision,
  cancelSprint,
  closeSprint,
  computeFlowMetrics,
  countsByState,
  createSprint,
  createTask,
  getTask,
  importTodoMd,
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
  renderTodoMd,
  setCheck,
  startSprint,
  unblockTask,
  updateTask,
} from '../store/index.js';
import {
  CLASSES_OF_SERVICE,
  DOD_CHECKS,
  DOR_CHECKS,
  PRIORITIES,
  PRIORITY_RANK,
  STATES,
  compareInColumn,
  type Actor,
  type CheckId,
  type ClassOfService,
  type Priority,
  type State,
  type Task,
  type TaskFilter,
} from '../store/types.js';
import type { KanbanConfig } from './config.js';

/** A one-line card summary: all a model needs to choose the next call. */
interface CardSummary {
  readonly id: string;
  readonly title: string;
  readonly state: State;
  readonly priority: Priority;
  readonly classOfService: ClassOfService;
  readonly assignee: string | null;
  readonly blocked: string | null;
  readonly dorMissing: readonly string[];
  readonly dodMissing: readonly string[];
  readonly rev: number;
}

function summarise(task: Task, dow: { dor: readonly string[]; dod: readonly string[] }): CardSummary {
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    priority: task.priority,
    classOfService: task.classOfService,
    assignee: task.assignee,
    blocked: task.blockedReason,
    dorMissing: dow.dor.filter((check) => task.dor[check as CheckId] === undefined),
    dodMissing: dow.dod.filter((check) => task.dod[check as CheckId] === undefined),
    rev: task.rev,
  };
}

function text(value: string): DshJson {
  return value;
}

function renderText(value: DshJson): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/** The actor for a tool call: the session that made it, or the plugin for an unattributed call. */
function actorOf(exec: DshToolRunContext): Actor {
  const id = exec.agent?.id;
  return id === undefined ? { kind: 'plugin', id: 'kanban' } : { kind: 'agent', id };
}

function json(value: unknown): DshJson {
  return JSON.parse(JSON.stringify(value ?? null)) as DshJson;
}

/** A compact board listing, ordered for reading rather than for the database. */
function boardText(tasks: readonly Task[], dow: { dor: readonly string[]; dod: readonly string[] }): string {
  if (tasks.length === 0) return 'No cards match.';
  const lines: string[] = [];
  for (const state of STATES) {
    const column = tasks.filter((task) => task.state === state).sort(compareInColumn);
    if (column.length === 0) continue;
    lines.push(`${state} (${column.length})`);
    for (const task of column) {
      const summary = summarise(task, dow);
      const flags: string[] = [];
      if (summary.blocked !== null) flags.push('BLOCKED');
      if (summary.classOfService === 'expedite') flags.push('EXPEDITE');
      if (summary.dorMissing.length > 0 && state === 'backlog') flags.push(`DoR missing: ${summary.dorMissing.join(', ')}`);
      if (summary.dodMissing.length > 0 && state === 'review') flags.push(`DoD missing: ${summary.dodMissing.join(', ')}`);
      lines.push(
        `  ${task.id} ${task.priority} ${task.title}${summary.assignee === null ? '' : ` [${summary.assignee}]`}${
          flags.length > 0 ? ` — ${flags.join('; ')}` : ''
        }`
      );
    }
  }
  return lines.join('\n');
}

export interface ToolDeps {
  readonly board: () => Board;
  readonly config: () => KanbanConfig;
  readonly mirror: () => void;
}

/** Build every tool definition. */
export function createTools(deps: ToolDeps): DshToolDefinition[] {
  const dow = (): { dor: readonly string[]; dod: readonly string[] } => {
    const definition = readDow(deps.board());
    return { dor: definition.dor, dod: definition.dod };
  };

  const listTool: DshToolDefinition = {
    name: 'kanban_list',
    description:
      'List cards on the shared Kanban board, grouped by state, with what each one is waiting for. Use it to decide what to work on next: `state: ["ready"]` is the pullable column.',
    parameters: {
      state: { type: 'array', description: 'Filter to these states.', items: { type: 'string', enum: [...STATES] } },
      priority: { type: 'array', description: 'Filter to these priorities.', items: { type: 'string', enum: [...PRIORITIES] } },
      assignee: { type: 'string', description: 'Filter by assignee, e.g. an agent name or "human".' },
      project: { type: 'string', description: 'Filter by project.' },
      workspace: { type: 'string', description: 'Filter by workspace path or id.' },
      sprintId: { type: 'string', description: 'Filter by sprint id.' },
      tag: { type: 'string', description: 'Filter by tag.' },
      blocked: { type: 'boolean', description: 'true for blocked cards only, false to exclude them.' },
      search: { type: 'string', description: 'Free text over id, title, outcome and description.' },
      limit: { type: 'integer', description: 'Maximum cards (default 200, max 500).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          cards: { type: 'array', required: true, items: { type: 'string' } },
          wip: { type: 'object', required: true, additionalProperties: true, properties: {} },
        },
      },
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const filter: TaskFilter = {
        ...(Array.isArray(input.state) && input.state.length > 0 ? { state: input.state as State[] } : {}),
        ...(Array.isArray(input.priority) && input.priority.length > 0 ? { priority: input.priority as Priority[] } : {}),
        ...(typeof input.assignee === 'string' ? { assignee: input.assignee } : {}),
        ...(typeof input.project === 'string' ? { project: input.project } : {}),
        ...(typeof input.workspace === 'string' ? { workspace: input.workspace } : {}),
        ...(typeof input.sprintId === 'string' ? { sprintId: input.sprintId } : {}),
        ...(typeof input.tag === 'string' ? { tag: input.tag } : {}),
        ...(typeof input.blocked === 'boolean' ? { blocked: input.blocked } : {}),
        ...(typeof input.search === 'string' ? { search: input.search } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      };
      const board = deps.board();
      const listed = listTasks(board, filter);
      const definition = dow();
      const counts = countsByState(board);
      const header = `${listed.tasks.length} of ${listed.total} cards · WIP ${counts['in-progress'] ?? 0}/${
        readDow(board).wip['in-progress']
      } in progress, ${counts.review ?? 0}/${readDow(board).wip.review} in review`;
      return json({
        count: listed.tasks.length,
        cards: [`${header}`, '', boardText(listed.tasks, definition)].join('\n'),
        wip: counts,
      });
    },
  };

  const getTool: DshToolDefinition = {
    name: 'kanban_get',
    description: 'Read one card in full: its checklists, comments and change history.',
    parameters: { id: { type: 'string', required: true, description: 'The card id, e.g. T-013.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { card: { type: 'string', required: true } } },
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const { id } = (args ?? {}) as { id?: string };
      if (typeof id !== 'string') throw new Error('kanban_get needs an id');
      const board = deps.board();
      const task = getTask(board, id);
      if (task === undefined) throw new Error(`no card ${id}`);
      const comments = listComments(board, id);
      const events = listEvents(board, { taskId: id, limit: 50 });
      const definition = readDow(board);
      const missingDor = definition.dor.filter((check) => task.dor[check as CheckId] === undefined);
      const missingDod = definition.dod.filter((check) => task.dod[check as CheckId] === undefined);
      const lines = [
        `${task.id} — ${task.title}`,
        `state ${task.state} · ${task.priority} · ${task.classOfService}${
          task.assignee === null ? '' : ` · ${task.assignee}`
        }${task.sprintId === null ? '' : ` · ${task.sprintId}`}`,
        task.blockedReason === null ? '' : `BLOCKED: ${task.blockedReason}`,
        task.droppedReason === null ? '' : `DROPPED: ${task.droppedReason}`,
        task.outcome === null ? '' : `outcome: ${task.outcome}`,
        task.acceptance === null ? '' : `acceptance: ${task.acceptance}`,
        task.description === null ? '' : `description: ${task.description}`,
        `DoR: ${missingDor.length === 0 ? 'complete' : `missing ${missingDor.join(', ')}`}`,
        `DoD: ${missingDod.length === 0 ? 'complete' : `missing ${missingDod.join(', ')}`}`,
        task.exceptions.length === 0 ? '' : `exceptions: ${task.exceptions.length}`,
        `rev ${task.rev} · created ${task.createdAt} by ${task.createdBy}`,
        comments.length === 0 ? 'no comments' : `comments: ${comments.map((c) => `${c.at} ${c.actor}: ${c.body}`).join(' | ')}`,
        `history: ${events.map((e) => `${e.at.slice(0, 16)} ${e.kind}${e.toState === null ? '' : `→${e.toState}`}`).join(', ')}`,
      ].filter((line) => line.length > 0);
      return json({ card: lines.join('\n'), task: json(task), comments: json(comments) });
    },
  };

  const createTool: DshToolDefinition = {
    name: 'kanban_create',
    description:
      'Create a card. It starts in `backlog`; refine it until the Definition of Ready is ticked, then move it. Use `template` to start from a saved blueprint.',
    parameters: {
      title: { type: 'string', required: true, description: 'A short imperative line: what the card is.' },
      outcome: { type: 'string', description: 'One line: what is true when this is done.' },
      acceptance: { type: 'string', description: 'How it will be judged. Required by the DoR.' },
      description: { type: 'string', description: 'Context, links, anything the next reader needs.' },
      priority: { type: 'string', enum: [...PRIORITIES], description: "The human's to set; omit and propose it in a comment instead." },
      classOfService: {
        type: 'string',
        enum: [...CLASSES_OF_SERVICE],
        description: "The human's to set. `expedite` is the only exception to a WIP limit.",
      },
      assignee: { type: 'string', description: 'An agent name, a teammate name, or "human".' },
      project: { type: 'string', description: 'Project this belongs to.' },
      workspace: { type: 'string', description: 'Workspace path or id.' },
      estimate: { type: 'number', description: 'Size in points.' },
      folder: { type: 'string', description: 'The task folder, e.g. tasks/T-013-slug.' },
      template: { type: 'string', description: 'A template id from kanban_board.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { id: { type: 'string', required: true } } },
      render: (_args, value) => renderText(value),
    },
    execute: async (args, exec) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const board = deps.board();
      const templates = listTemplates(board);
      const chosen = typeof input.template === 'string' ? templates.find((entry) => entry.id === input.template) : undefined;
      if (typeof input.template === 'string' && chosen === undefined) {
        throw new Error(`no template ${input.template}; known: ${templates.map((entry) => entry.id).join(', ')}`);
      }
      const task = createTask(
        board,
        {
          title: typeof input.title === 'string' ? input.title : '',
          ...(chosen === undefined ? {} : (chosen.patch as Record<string, never>)),
          ...(typeof input.outcome === 'string' ? { outcome: input.outcome } : {}),
          ...(typeof input.acceptance === 'string' ? { acceptance: input.acceptance } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
          ...(typeof input.priority === 'string' ? { priority: input.priority as Priority } : {}),
          ...(typeof input.classOfService === 'string' ? { classOfService: input.classOfService as ClassOfService } : {}),
          ...(typeof input.assignee === 'string' ? { assignee: input.assignee } : {}),
          ...(typeof input.project === 'string' ? { project: input.project } : {}),
          ...(typeof input.workspace === 'string' ? { workspace: input.workspace } : {}),
          ...(typeof input.estimate === 'number' ? { estimate: input.estimate } : {}),
          ...(typeof input.folder === 'string' ? { folder: input.folder } : {}),
        },
        { actor: actorOf(exec), now: new Date() }
      );
      deps.mirror();
      return json({ id: task.id, card: `${task.id} created in backlog: ${task.title}`, task: json(task) });
    },
  };

  const updateTool: DshToolDefinition = {
    name: 'kanban_update',
    description:
      'Change one card. `action` selects the verb: `edit` (default) for prose and metadata, `check` to tick a Definition of Ready/Done item, `comment` to say something, `block`/`unblock`. Priority and class of service are the human\'s to set.',
    parameters: {
      id: { type: 'string', required: true, description: 'The card id.' },
      action: {
        type: 'string',
        enum: ['edit', 'check', 'comment', 'block', 'unblock'],
        description: 'What to do. Defaults to edit.',
      },
      title: { type: 'string', description: 'edit: new title.' },
      outcome: { type: 'string', description: 'edit: one-line outcome.' },
      acceptance: { type: 'string', description: 'edit: acceptance criteria.' },
      description: { type: 'string', description: 'edit: context.' },
      assignee: { type: 'string', description: 'edit: assignee.' },
      project: { type: 'string', description: 'edit: project.' },
      workspace: { type: 'string', description: 'edit: workspace.' },
      tags: { type: 'array', description: 'edit: replace the tags.', items: { type: 'string' } },
      folder: { type: 'string', description: 'edit: task folder.' },
      estimate: { type: 'number', description: 'edit: size in points.' },
      priority: { type: 'string', enum: [...PRIORITIES], description: 'edit (human only): priority.' },
      classOfService: { type: 'string', enum: [...CLASSES_OF_SERVICE], description: 'edit (human only): class of service.' },
      gate: { type: 'string', enum: ['dor', 'dod'], description: 'check: which checklist.' },
      checkId: {
        type: 'string',
        enum: [...DOR_CHECKS, ...DOD_CHECKS],
        description: 'check: which item.',
      },
      done: { type: 'boolean', description: 'check: tick (true, default) or untick (false).' },
      body: { type: 'string', description: 'comment: the text.' },
      reason: { type: 'string', description: 'block: why it is blocked.' },
      expectedRev: { type: 'integer', description: 'Refuse the write if the card has moved on since this rev.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { card: { type: 'string', required: true } } },
      render: (_args, value) => renderText(value),
    },
    execute: async (args, exec) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const id = typeof input.id === 'string' ? input.id : '';
      if (id.length === 0) throw new Error('kanban_update needs an id');
      const action = typeof input.action === 'string' ? input.action : 'edit';
      const board = deps.board();
      const actor = actorOf(exec);
      const now = new Date();
      const expectedRev = typeof input.expectedRev === 'number' ? input.expectedRev : undefined;

      if (action === 'check') {
        const gate = input.gate === 'dod' ? 'dod' : 'dor';
        const checkId = typeof input.checkId === 'string' ? input.checkId : '';
        const task = setCheck(board, id, gate, checkId, input.done !== false, { actor, now });
        deps.mirror();
        return json({ card: `${task.id} ${gate} ${checkId} ${input.done !== false ? 'ticked' : 'unticked'}`, task: json(task) });
      }
      if (action === 'comment') {
        const comment = addComment(board, id, typeof input.body === 'string' ? input.body : '', { actor, now });
        return json({ card: `commented on ${id}`, comment: json(comment) });
      }
      if (action === 'block') {
        const task = blockTask(board, id, typeof input.reason === 'string' ? input.reason : '', { actor, now });
        deps.mirror();
        return json({ card: `${task.id} blocked: ${task.blockedReason ?? ''}`, task: json(task) });
      }
      if (action === 'unblock') {
        const task = unblockTask(board, id, { actor, now });
        deps.mirror();
        return json({ card: `${task.id} unblocked`, task: json(task) });
      }

      const patch: Record<string, unknown> = {};
      for (const key of ['title', 'outcome', 'acceptance', 'description', 'assignee', 'project', 'workspace', 'folder', 'estimate', 'priority', 'classOfService', 'tags']) {
        if (input[key] !== undefined) patch[key] = input[key];
      }
      const task = updateTask(
        board,
        id,
        patch as never,
        expectedRev === undefined ? { actor, now } : { actor, now, expectedRev }
      );
      deps.mirror();
      return json({ card: `${task.id} updated (${Object.keys(patch).join(', ') || 'nothing'})`, task: json(task) });
    },
  };

  const moveTool: DshToolDefinition = {
    name: 'kanban_move',
    description:
      'Move a card between columns. Enforces the Definition of Ready when leaving backlog, the Definition of Done when entering done, the WIP limits, and the ban on moving a blocked card into work. A refusal names exactly what is missing — do not work around it.',
    parameters: {
      id: { type: 'string', required: true, description: 'The card id.' },
      toState: { type: 'string', required: true, enum: [...STATES], description: 'The target column.' },
      toPosition: { type: 'number', description: 'Order inside the column; omit to append.' },
      reason: { type: 'string', description: 'Required when dropping or reopening a finished card.' },
      force: { type: 'boolean', description: 'Except a gate. Human only, and requires a reason.' },
      expectedRev: { type: 'integer', description: 'Refuse the write if the card has moved on since this rev.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { card: { type: 'string', required: true } } },
      render: (_args, value) => renderText(value),
    },
    execute: async (args, exec) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const id = typeof input.id === 'string' ? input.id : '';
      const toState = typeof input.toState === 'string' ? (input.toState as State) : undefined;
      if (id.length === 0 || toState === undefined) throw new Error('kanban_move needs an id and a toState');
      const task = moveTask(
        deps.board(),
        {
          id,
          toState,
          ...(typeof input.toPosition === 'number' ? { toPosition: input.toPosition } : {}),
          ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
          ...(typeof input.force === 'boolean' ? { force: input.force } : {}),
          ...(typeof input.expectedRev === 'number' ? { expectedRev: input.expectedRev } : {}),
        },
        { actor: actorOf(exec), now: new Date() }
      );
      deps.mirror();
      return json({
        card: `${task.id} → ${task.state} (rev ${task.rev})${task.startedAt === null ? '' : ` · started ${task.startedAt}`}`,
        task: json(task),
      });
    },
  };

  const deleteTool: DshToolDefinition = {
    name: 'kanban_delete',
    description:
      'Remove a card. `drop` (default) marks it abandoned with a reason and keeps it in the throughput history; `purge` deletes the row and only the human may do that.',
    parameters: {
      id: { type: 'string', required: true, description: 'The card id.' },
      mode: { type: 'string', enum: ['drop', 'purge'], description: 'Defaults to drop.' },
      reason: { type: 'string', description: 'Required for drop: why it is abandoned.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { card: { type: 'string', required: true } } },
      render: (_args, value) => renderText(value),
    },
    execute: async (args, exec) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const id = typeof input.id === 'string' ? input.id : '';
      if (id.length === 0) throw new Error('kanban_delete needs an id');
      const actor = actorOf(exec);
      const now = new Date();
      if (input.mode === 'purge') {
        purgeTask(deps.board(), id, { actor, now });
        deps.mirror();
        return json({ card: `${id} purged` });
      }
      const task = moveTask(
        deps.board(),
        { id, toState: 'dropped', reason: typeof input.reason === 'string' ? input.reason : '' },
        { actor, now }
      );
      deps.mirror();
      return json({ card: `${task.id} dropped: ${task.droppedReason ?? ''}`, task: json(task) });
    },
  };

  const sprintTool: DshToolDefinition = {
    name: 'kanban_sprint',
    description:
      'Work with sprints — an optional timebox of 31 days or less with a goal. `create` needs a start and end; `start` activates one (only one at a time); `close` returns unfinished cards to the backlog; `cancel` is human-only.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'create', 'start', 'close', 'cancel'], description: 'What to do.' },
      id: { type: 'string', description: 'The sprint id, e.g. S-001.' },
      name: { type: 'string', description: 'create: a name.' },
      goal: { type: 'string', description: 'create: the sprint goal — why this timebox is worth it.' },
      start: { type: 'string', description: 'create: start date or instant (ISO).' },
      end: { type: 'string', description: 'create: end date or instant (ISO), at most 31 days later.' },
      reason: { type: 'string', description: 'cancel: why.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string', required: true } } },
      render: (_args, value) => renderText(value),
    },
    execute: async (args, exec) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const board = deps.board();
      const action = typeof input.action === 'string' ? input.action : 'list';
      const actor = actorOf(exec);
      const now = new Date();

      if (action === 'create') {
        const sprint = createSprint(
          board,
          {
            name: typeof input.name === 'string' ? input.name : 'Sprint',
            goal: typeof input.goal === 'string' ? input.goal : '',
            start: typeof input.start === 'string' ? input.start : '',
            end: typeof input.end === 'string' ? input.end : '',
          },
          { actor, now }
        );
        return json({ summary: `${sprint.id} created (${sprint.start} → ${sprint.end})`, sprint: json(sprint) });
      }
      if (action === 'start' || action === 'close' || action === 'cancel') {
        // Validated here rather than let through: `startSprint('')` reports `sprint "" does not
        // exist`, which tells a model nothing about what it forgot.
        const sprintId = typeof input.id === 'string' ? input.id : '';
        if (sprintId.length === 0) throw new Error(`kanban_sprint needs an id for ${action}`);
        if (action === 'start') {
          const sprint = startSprint(board, sprintId, { actor, now });
          return json({ summary: `${sprint.id} active: ${sprint.goal}`, sprint: json(sprint) });
        }
        if (action === 'close') {
          const result = closeSprint(board, sprintId, { actor, now });
          deps.mirror();
          return json({
            summary: `${result.sprint.id} closed; ${result.returned.length} unfinished card(s) returned to the backlog`,
            returned: json(result.returned),
          });
        }
        const sprint = cancelSprint(
          board,
          sprintId,
          typeof input.reason === 'string' ? input.reason : '',
          { actor, now }
        );
        deps.mirror();
        return json({ summary: `${sprint.id} cancelled`, sprint: json(sprint) });
      }
      const sprints = listSprints(board);
      return json({
        summary:
          sprints.length === 0
            ? 'No sprints yet.'
            : sprints.map((sprint) => `${sprint.id} ${sprint.state} ${sprint.start}→${sprint.end} ${sprint.goal}`).join('\n'),
      });
    },
  };

  const boardTool: DshToolDefinition = {
    name: 'kanban_board',
    description:
      'Read the board itself: the Definition of Workflow (states, WIP limits, SLE, policies), saved views, task templates, the generated Markdown mirror, or the raw export. `import-todo` migrates a pre-Kanban `todo.md` table.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['dow', 'views', 'templates', 'export', 'mirror', 'import-todo'],
        description: 'What to read or do.',
      },
      text: { type: 'string', description: 'import-todo: the Markdown table to import.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string', required: true } } },
      render: (_args, value) => renderText(value),
    },
    execute: async (args, exec) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const board = deps.board();
      const action = typeof input.action === 'string' ? input.action : 'dow';

      if (action === 'views') {
        return json({ summary: listViews(board).map((view) => `${view.id}: ${view.name} — ${view.description}`).join('\n') || 'No views.' });
      }
      if (action === 'templates') {
        return json({
          summary:
            listTemplates(board)
              .map((template) => `${template.id}: ${template.name} — ${template.description}`)
              .join('\n') || 'No templates.',
        });
      }
      if (action === 'import-todo') {
        const result = importTodoMd(board, typeof input.text === 'string' ? input.text : '', {
          actor: actorOf(exec),
          now: new Date(),
        });
        deps.mirror();
        return json({
          summary: `imported ${result.imported.length} of ${result.rows} rows; skipped ${result.skipped.length} that already existed`,
          imported: [...result.imported],
          skipped: [...result.skipped],
          rows: result.rows,
        });
      }
      if (action === 'mirror') {
        deps.mirror();
        return json({ summary: `wrote the Markdown mirror to ${deps.config().mirrorPath}` });
      }
      if (action === 'export') {
        const listed = listTasks(board, { limit: 500 });
        const markdown = renderTodoMd({
          tasks: listed.tasks,
          dow: readDow(board),
          metrics: computeFlowMetrics({ tasks: listed.tasks, now: new Date(), dow: readDow(board), boardRev: boardRevision(board) }),
          boardTitle: readBoardTitle(board),
          boardRev: boardRevision(board),
          generatedAt: new Date().toISOString(),
          invalid: listed.invalid,
        });
        return json({ summary: markdown });
      }

      const definition = readDow(board);
      const lines = [
        `Board ${readBoardTitle(board)} · rev ${boardRevision(board)}`,
        `WIP control: ${Object.entries(definition.wip).map(([state, limit]) => `${state} ${limit}`).join(', ')} · ready cap ${definition.readyCap}`,
        `SLE: ${Math.round(definition.sle.p * 100)}% finish in ${definition.sle.days} day(s) or less (${definition.sle.source})`,
        `DoR: ${definition.dor.join(', ')}`,
        `DoD: ${definition.dod.join(', ')}`,
        'Policies:',
        ...STATES.map((state) => `  ${state}: ${definition.policies[state]}`),
      ];
      return json({ summary: lines.join('\n'), dow: json(definition) });
    },
  };

  const metricsTool: DshToolDefinition = {
    name: 'kanban_metrics',
    description:
      'The four flow metrics the Kanban Guide requires — WIP, throughput, work item age, cycle time — plus the Service Level Expectation and which cards are past it.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string', required: true } } },
      render: (_args, value) => renderText(value),
    },
    execute: async () => {
      const board = deps.board();
      const listed = listTasks(board, { limit: 500 });
      const definition = readDow(board);
      const metrics = computeFlowMetrics({
        tasks: listed.tasks,
        now: new Date(),
        dow: definition,
        boardRev: boardRevision(board),
      });
      const lines = [
        `WIP ${metrics.wip} (${Object.entries(metrics.wipByState).map(([state, count]) => `${state} ${count}`).join(', ')})`,
        `Throughput ${metrics.throughput.days7} in 7 days · ${metrics.throughput.days30} in 30 days`,
        `Cycle time median ${metrics.cycle.medianDays ?? '—'}d · p85 ${metrics.cycle.p85Days ?? '—'}d over ${metrics.cycle.count} finished`,
        `Work item age: oldest ${metrics.ageing.oldestDays ?? '—'}d · ${metrics.ageing.count} past the SLE`,
        `SLE ${Math.round(metrics.sle.p * 100)}% ≤ ${metrics.sle.days}d (${metrics.sle.source}, basis ${metrics.sle.basis})`,
        metrics.ages.length === 0
          ? 'Nothing is in progress.'
          : `Ageing: ${metrics.ages.map((entry) => `${entry.id} ${entry.days}d${entry.overSle ? ' (past SLE)' : ''}`).join(', ')}`,
      ];
      return json({ summary: lines.join('\n'), metrics: json(metrics) });
    },
  };

  return [listTool, getTool, createTool, updateTool, moveTool, deleteTool, sprintTool, boardTool, metricsTool];
}

/** Tool names, for the probe record and for `listTools` verification. */
export const TOOL_NAMES: readonly string[] = [
  'kanban_list',
  'kanban_get',
  'kanban_create',
  'kanban_update',
  'kanban_move',
  'kanban_delete',
  'kanban_sprint',
  'kanban_board',
  'kanban_metrics',
];

/** Keep the helper used by `list` reachable for tests without exporting the whole module shape. */
export { PRIORITY_RANK, text };
