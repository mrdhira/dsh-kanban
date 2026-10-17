#!/usr/bin/env node
/**
 * `dsh-kanban` — the human's command line over the same store the panel and the agents use.
 *
 * Three reasons this exists rather than a second implementation of the rules:
 *
 * 1. **The board must be readable without the app.** A `cat`, a diff, an ssh session, a phone.
 * 2. **A check has to be able to assert on state.** "I dragged a card" is a claim; `kanban show
 *    T-013` after the drag is evidence, and the acceptance criteria in `requirements.md` are
 *    written that way on purpose.
 * 3. **One policy engine.** Every verb here calls the same `src/store` functions the tools and the
 *    route call, so a WIP limit cannot be true in one place and false in another.
 *
 * No dependencies and no build step of its own beyond the plugin's: `build.mjs` bundles it from
 * these sources into a single executable `bin/kanban.mjs`, so the store it runs is compiled from
 * the same TypeScript the tests and the plugin use — never a copy that can drift.
 */
import {
  ConflictError,
  InvalidError,
  NotFoundError,
  PolicyViolation,
  StoreError,
  addComment,
  blockTask,
  boardRevision,
  cancelSprint,
  closeSprint,
  computeFlowMetrics,
  countsByState,
  createSprint,
  createTask,
  defaultBoardPath,
  getTask,
  listComments,
  listEvents,
  listSprints,
  listTasks,
  listTemplates,
  listViews,
  moveTask,
  openBoard,
  purgeTask,
  readBoardTitle,
  readDow,
  setCheck,
  startSprint,
  unblockTask,
  updateTask,
  type Actor,
  type ClassOfService,
  type Link,
  type Priority,
  type State,
  type Task,
} from '../store/index.js';

/** Distinct exit codes, because a script can branch on a number and not on prose. */
const EXIT = { ok: 0, usage: 1, notFound: 2, policy: 3, conflict: 4, invalid: 5 };

// --------------------------------------------------------------------------- arguments

interface Parsed {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
  /** Flags that may be given more than once, in the order they were written. */
  readonly lists: Readonly<Record<string, readonly string[]>>;
}

const BOOLEAN_FLAGS = new Set(['json', 'force', 'off', 'blocked', 'all', 'help']);
const LIST_FLAGS = new Set(['write-scope']);

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const lists: Record<string, string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals > 0) {
      const name = body.slice(0, equals);
      const value = body.slice(equals + 1);
      if (LIST_FLAGS.has(name)) {
        (lists[name] ??= []).push(value);
      } else {
        flags[name] = value;
      }
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new InvalidError(`--${body} needs a value`);
    }
    if (LIST_FLAGS.has(body)) {
      (lists[body] ??= []).push(value);
    } else {
      flags[body] = value;
    }
    index += 1;
  }
  return { command: positional.shift() ?? 'help', positional, flags, lists };
}

function flagString(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' ? value : undefined;
}

function flagNumber(parsed: Parsed, name: string): number | undefined {
  const raw = flagString(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new InvalidError(`--${name} must be a number`);
  return value;
}

/**
 * A flag that may be repeated, or `undefined` when it was not given.
 *
 * An empty value is the clear: `--write-scope=` (or `--write-scope ''`) means "no prefixes", the
 * same way an empty `--tags` empties the tag list. Several values are passed through **untouched**,
 * including a bad one in the middle: normalizing or filtering here would duplicate the store's rule
 * and let the CLI accept a scope the board would refuse. The store refuses it, and the existing
 * error path turns that into exit 5.
 */
function flagList(parsed: Parsed, name: string): readonly string[] | undefined {
  const values = parsed.lists[name];
  if (values === undefined) return undefined;
  if (values.length === 1 && values[0] === '') return [];
  return values;
}

/**
 * Who ran this.
 *
 * The default is `human`, because this is the human's tool on the human's machine — the same
 * permissive default the HTTP route takes, for the same reason: the boundary the board actually
 * enforces is "an agent may not set a priority", and an agent is identified by its session, not by
 * a flag it could omit. An agent calling this CLI is asked to be honest with `--actor agent:<id>`,
 * and its tool calls record that automatically.
 */
function actorFrom(parsed: Parsed): Actor {
  const raw = flagString(parsed, 'actor') ?? 'human';
  if (raw === 'human') return { kind: 'human', id: 'dhira' };
  if (raw === 'cli') return { kind: 'cli', id: 'cli' };
  if (raw.startsWith('agent:')) return { kind: 'agent', id: raw.slice('agent:'.length) };
  return { kind: 'cli', id: raw };
}

// --------------------------------------------------------------------------- output

const useJson = (parsed: Parsed): boolean => parsed.flags.json === true;

function out(parsed: Parsed, human: string, machine: unknown): void {
  if (useJson(parsed)) {
    process.stdout.write(`${JSON.stringify(machine, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${human}\n`);
}

function summarise(task: Task): string {
  const flags: string[] = [];
  if (task.blockedReason !== null) flags.push('BLOCKED');
  if (task.classOfService === 'expedite') flags.push('EXPEDITE');
  if (task.sprintId !== null) flags.push(task.sprintId);
  return `${task.id.padEnd(6)} ${task.state.padEnd(12)} ${task.priority.padEnd(12)} ${task.title}${
    task.assignee === null ? '' : `  [${task.assignee}]`
  }${flags.length === 0 ? '' : `  ${flags.join(' ')}`}`;
}

const USAGE = `dsh-kanban — the Kanban board from the command line

  kanban list [--state s] [--assignee a] [--project p] [--sprint id] [--tag t]
              [--blocked] [--search q] [--all] [--json]
  kanban show <id> [--json]
  kanban add --title "…" [--outcome …] [--acceptance …] [--description …]
             [--priority p0-critical…p4-someday] [--assignee who] [--project p]
             [--workspace w] [--estimate n] [--folder path] [--template id] [--tags a,b]
             [--write-scope prefix]…
  kanban update <id> [--title …] [--outcome …] [--acceptance …] [--description …]
             [--assignee …] [--project …] [--workspace …] [--estimate n] [--tags a,b]
             [--priority …] [--class …] [--rev n] [--write-scope prefix]…
  kanban move <id> <state> [--position n] [--reason …] [--force] [--rev n]
  kanban check <id> <dor|dod> <check-id> [--off]
  kanban block <id> --reason "…"        kanban unblock <id>
  kanban drop <id> --reason "…"         kanban purge <id>
  kanban comment <id> --body "…"
  kanban sprint list|create|start|close|cancel [--id S-001] [--name …] [--goal …]
               [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--reason …]
  kanban metrics [--json]
  kanban board [--json]
  kanban where

  --db <path>    the board file        (default ${defaultBoardPath()})
  --actor <who>  human | cli | agent:<session-id>   (default human)
  --json         machine-readable output
  --write-scope <prefix>  workspace-relative write prefix; repeat for a list.
                          An empty value (--write-scope=) clears the scope on update,
                          the same way an empty --tags clears the tags.

Exit: 0 ok · 1 usage · 2 not found · 3 policy refusal · 4 revision conflict · 5 invalid`;

// --------------------------------------------------------------------------- commands

function commandList(parsed: Parsed, board: ReturnType<typeof openBoard>): void {
  const states = flagString(parsed, 'state')?.split(',').filter(Boolean) as State[] | undefined;
  const priorities = flagString(parsed, 'priority')?.split(',').filter(Boolean) as Priority[] | undefined;
  const filter = {
    ...(states === undefined ? {} : { state: states }),
    ...(priorities === undefined ? {} : { priority: priorities }),
    ...(flagString(parsed, 'assignee') === undefined ? {} : { assignee: flagString(parsed, 'assignee') as string }),
    ...(flagString(parsed, 'project') === undefined ? {} : { project: flagString(parsed, 'project') as string }),
    ...(flagString(parsed, 'workspace') === undefined ? {} : { workspace: flagString(parsed, 'workspace') as string }),
    ...(flagString(parsed, 'sprint') === undefined ? {} : { sprintId: flagString(parsed, 'sprint') as string }),
    ...(flagString(parsed, 'tag') === undefined ? {} : { tag: flagString(parsed, 'tag') as string }),
    ...(flagString(parsed, 'search') === undefined ? {} : { search: flagString(parsed, 'search') as string }),
    ...(parsed.flags.blocked === true ? { blocked: true } : {}),
    limit: 500,
  };
  const listed = listTasks(board, filter);
  const counts = countsByState(board);
  const dow = readDow(board);
  const header = `rev ${boardRevision(board)} · ${listed.total} card(s) · WIP ${counts['in-progress'] ?? 0}/${dow.wip['in-progress']} in progress, ${counts.review ?? 0}/${dow.wip.review} in review`;
  const body = listed.tasks.map(summarise).join('\n');
  out(parsed, `${header}\n${body}`, { rev: boardRevision(board), counts, tasks: listed.tasks, invalid: listed.invalid });
}

function commandShow(parsed: Parsed, board: ReturnType<typeof openBoard>): void {
  const id = parsed.positional[0];
  if (id === undefined) throw new InvalidError('show needs a card id');
  const task = getTask(board, id);
  if (task === undefined) throw new NotFoundError('task', id);
  const comments = listComments(board, id);
  const events = listEvents(board, { taskId: id, limit: 40 });
  const dow = readDow(board);
  const missingDor = dow.dor.filter((check) => task.dor[check as keyof typeof task.dor] === undefined);
  const missingDod = dow.dod.filter((check) => task.dod[check as keyof typeof task.dod] === undefined);
  const lines = [
    `${task.id}  ${task.title}`,
    `  state        ${task.state}${task.blockedReason === null ? '' : `  BLOCKED: ${task.blockedReason}`}${
      task.droppedReason === null ? '' : `  DROPPED: ${task.droppedReason}`
    }`,
    `  priority     ${task.priority}   class ${task.classOfService}`,
    `  assignee     ${task.assignee ?? '—'}   project ${task.project ?? '—'}   workspace ${task.workspace ?? '—'}`,
    `  sprint       ${task.sprintId ?? '—'}   estimate ${task.estimate ?? '—'}   due ${task.due ?? '—'}`,
    `  folder       ${task.folder ?? '—'}`,
    `  DoR          ${missingDor.length === 0 ? 'complete' : `missing ${missingDor.join(', ')}`}`,
    `  DoD          ${missingDod.length === 0 ? 'complete' : `missing ${missingDod.join(', ')}`}`,
    `  exceptions   ${task.exceptions.length === 0 ? 'none' : task.exceptions.map((entry) => `${entry.by}: ${entry.reason}`).join(' | ')}`,
    `  outcome      ${task.outcome ?? '—'}`,
    `  acceptance   ${task.acceptance ?? '—'}`,
    `  description  ${task.description ?? '—'}`,
    `  links        ${task.links.length === 0 ? '—' : task.links.map((link) => `${link.kind}:${link.ref}`).join(', ')}`,
    `  rev ${task.rev}   created ${task.createdAt} by ${task.createdBy}   updated ${task.updatedAt} by ${task.updatedBy}`,
    `  started ${task.startedAt ?? '—'}   finished ${task.finishedAt ?? '—'}`,
    `  comments     ${comments.length === 0 ? 'none' : comments.map((entry) => `${entry.at} ${entry.actor}: ${entry.body}`).join(' | ')}`,
    `  history      ${events.map((entry) => `${entry.at} ${entry.kind}${entry.toState === null ? '' : `→${entry.toState}`}`).join(', ')}`,
  ];
  out(parsed, lines.join('\n'), { task, comments, events });
}

function commandAdd(parsed: Parsed, board: ReturnType<typeof openBoard>): void {
  const title = flagString(parsed, 'title');
  if (title === undefined) throw new InvalidError('add needs --title');
  const templates = listTemplates(board);
  const templateId = flagString(parsed, 'template');
  const template = templateId === undefined ? undefined : templates.find((entry) => entry.id === templateId);
  if (templateId !== undefined && template === undefined) {
    throw new InvalidError(`no template ${templateId}; known: ${templates.map((entry) => entry.id).join(', ')}`);
  }
  const tags = flagString(parsed, 'tags')?.split(',').filter(Boolean);
  const writeScopes = flagList(parsed, 'write-scope');
  const task = createTask(
    board,
    {
      title,
      ...(flagString(parsed, 'id') === undefined ? {} : { id: flagString(parsed, 'id') as string }),
      ...(template === undefined ? {} : (template.patch as Record<string, never>)),
      ...(flagString(parsed, 'outcome') === undefined ? {} : { outcome: flagString(parsed, 'outcome') as string }),
      ...(flagString(parsed, 'acceptance') === undefined ? {} : { acceptance: flagString(parsed, 'acceptance') as string }),
      ...(flagString(parsed, 'description') === undefined ? {} : { description: flagString(parsed, 'description') as string }),
      ...(flagString(parsed, 'priority') === undefined ? {} : { priority: flagString(parsed, 'priority') as Priority }),
      ...(flagString(parsed, 'class') === undefined ? {} : { classOfService: flagString(parsed, 'class') as ClassOfService }),
      ...(flagString(parsed, 'assignee') === undefined ? {} : { assignee: flagString(parsed, 'assignee') as string }),
      ...(flagString(parsed, 'project') === undefined ? {} : { project: flagString(parsed, 'project') as string }),
      ...(flagString(parsed, 'workspace') === undefined ? {} : { workspace: flagString(parsed, 'workspace') as string }),
      ...(flagString(parsed, 'folder') === undefined ? {} : { folder: flagString(parsed, 'folder') as string }),
      ...(flagNumber(parsed, 'estimate') === undefined ? {} : { estimate: flagNumber(parsed, 'estimate') as number }),
      ...(tags === undefined ? {} : { tags }),
      ...(writeScopes === undefined ? {} : { writeScopes }),
    },
    { actor: actorFrom(parsed), now: new Date() }
  );
  out(parsed, `${task.id} created in backlog: ${task.title}`, task);
}

function commandUpdate(parsed: Parsed, board: ReturnType<typeof openBoard>): void {
  const id = parsed.positional[0];
  if (id === undefined) throw new InvalidError('update needs a card id');
  const tags = flagString(parsed, 'tags')?.split(',').filter(Boolean);
  const links = flagString(parsed, 'link');
  const writeScopes = flagList(parsed, 'write-scope');
  const patch: Record<string, unknown> = {};
  for (const key of ['title', 'outcome', 'acceptance', 'description', 'assignee', 'project', 'workspace', 'folder']) {
    const value = flagString(parsed, key);
    if (value !== undefined) patch[key] = value;
  }
  if (flagString(parsed, 'priority') !== undefined) patch.priority = flagString(parsed, 'priority');
  if (flagString(parsed, 'class') !== undefined) patch.classOfService = flagString(parsed, 'class');
  if (flagNumber(parsed, 'estimate') !== undefined) patch.estimate = flagNumber(parsed, 'estimate');
  if (tags !== undefined) patch.tags = tags;
  if (writeScopes !== undefined) patch.writeScopes = writeScopes;
  if (links !== undefined) {
    const link: Link = links.startsWith('http') ? { kind: 'url', ref: links } : { kind: 'file', ref: links };
    patch.links = [link];
  }
  const rev = flagNumber(parsed, 'rev');
  const task = updateTask(board, id, patch as never, rev === undefined ? { actor: actorFrom(parsed), now: new Date() } : { actor: actorFrom(parsed), now: new Date(), expectedRev: rev });
  out(parsed, `${task.id} updated (${Object.keys(patch).join(', ') || 'nothing'})`, task);
}

function commandMove(parsed: Parsed, board: ReturnType<typeof openBoard>): void {
  const [id, toState] = parsed.positional;
  if (id === undefined || toState === undefined) throw new InvalidError('move needs an id and a state');
  const rev = flagNumber(parsed, 'rev');
  const task = moveTask(
    board,
    {
      id,
      toState: toState as State,
      ...(flagNumber(parsed, 'position') === undefined ? {} : { toPosition: flagNumber(parsed, 'position') as number }),
      ...(flagString(parsed, 'reason') === undefined ? {} : { reason: flagString(parsed, 'reason') as string }),
      ...(parsed.flags.force === true ? { force: true } : {}),
      ...(rev === undefined ? {} : { expectedRev: rev }),
    },
    { actor: actorFrom(parsed), now: new Date() }
  );
  out(parsed, `${task.id} → ${task.state} (rev ${task.rev})`, task);
}

function commandCheck(parsed: Parsed, board: ReturnType<typeof openBoard>): void {
  const [id, gate, checkId] = parsed.positional;
  if (id === undefined || (gate !== 'dor' && gate !== 'dod') || checkId === undefined) {
    throw new InvalidError('check needs <id> <dor|dod> <check-id>');
  }
  const task = setCheck(board, id, gate, checkId, parsed.flags.off !== true, { actor: actorFrom(parsed), now: new Date() });
  out(parsed, `${task.id} ${gate}.${checkId} ${parsed.flags.off === true ? 'unticked' : 'ticked'}`, task);
}

function commandBlockish(parsed: Parsed, board: ReturnType<typeof openBoard>, kind: 'block' | 'unblock' | 'purge' | 'comment'): void {
  const id = parsed.positional[0];
  if (id === undefined) throw new InvalidError(`${kind} needs a card id`);
  const actor = actorFrom(parsed);
  const now = new Date();
  if (kind === 'block') {
    const task = blockTask(board, id, flagString(parsed, 'reason') ?? '', { actor, now });
    out(parsed, `${task.id} blocked: ${task.blockedReason ?? ''}`, task);
    return;
  }
  if (kind === 'unblock') {
    const task = unblockTask(board, id, { actor, now });
    out(parsed, `${task.id} unblocked`, task);
    return;
  }
  if (kind === 'purge') {
    purgeTask(board, id, { actor, now });
    out(parsed, `${id} purged`, { purged: id });
    return;
  }
  const comment = addComment(board, id, flagString(parsed, 'body') ?? '', { actor, now });
  out(parsed, `commented on ${id}`, comment);
}

function commandSprint(parsed: Parsed, board: ReturnType<typeof openBoard>): void {
  const action = parsed.positional[0] ?? 'list';
  const actor = actorFrom(parsed);
  const now = new Date();
  const id = flagString(parsed, 'id');

  if (action === 'create') {
    const sprint = createSprint(
      board,
      {
        name: flagString(parsed, 'name') ?? 'Sprint',
        goal: flagString(parsed, 'goal') ?? '',
        start: flagString(parsed, 'start') ?? '',
        end: flagString(parsed, 'end') ?? '',
      },
      { actor, now }
    );
    out(parsed, `${sprint.id} ${sprint.start} → ${sprint.end} (${sprint.state})`, sprint);
    return;
  }
  if (action === 'start' || action === 'close' || action === 'cancel') {
    if (id === undefined) throw new InvalidError(`sprint ${action} needs --id`);
    if (action === 'start') {
      const sprint = startSprint(board, id, { actor, now });
      out(parsed, `${sprint.id} active: ${sprint.goal}`, sprint);
      return;
    }
    if (action === 'close') {
      const result = closeSprint(board, id, { actor, now });
      out(parsed, `${result.sprint.id} closed; ${result.returned.length} card(s) returned to the backlog`, result);
      return;
    }
    const sprint = cancelSprint(board, id, flagString(parsed, 'reason') ?? '', { actor, now });
    out(parsed, `${sprint.id} cancelled`, sprint);
    return;
  }
  const sprints = listSprints(board);
  out(
    parsed,
    sprints.length === 0 ? 'no sprints' : sprints.map((sprint) => `${sprint.id}  ${sprint.state.padEnd(10)} ${sprint.start} → ${sprint.end}  ${sprint.name}: ${sprint.goal}`).join('\n'),
    sprints
  );
}

function commandMetrics(parsed: Parsed, board: ReturnType<typeof openBoard>): void {
  const listed = listTasks(board, { limit: 500 });
  const dow = readDow(board);
  const metrics = computeFlowMetrics({ tasks: listed.tasks, now: new Date(), dow, boardRev: boardRevision(board) });
  const lines = [
    `board rev      ${metrics.boardRev}`,
    `WIP            ${metrics.wip} (${Object.entries(metrics.wipByState).map(([state, count]) => `${state} ${count}`).join(', ')})`,
    `Throughput     ${metrics.throughput.days7} in 7d · ${metrics.throughput.days30} in 30d`,
    `Cycle time     median ${metrics.cycle.medianDays ?? '—'}d · p85 ${metrics.cycle.p85Days ?? '—'}d · mean ${metrics.cycle.meanDays ?? '—'}d over ${metrics.cycle.count}`,
    `Work item age  oldest ${metrics.ageing.oldestDays ?? '—'}d · ${metrics.ageing.count} past the SLE`,
    `SLE            ${Math.round(metrics.sle.p * 100)}% ≤ ${metrics.sle.days}d (${metrics.sle.source}, basis ${metrics.sle.basis})`,
    `Counts         ${Object.entries(metrics.countsByState).map(([state, count]) => `${state} ${count}`).join(' · ')}`,
    ...(metrics.ages.length === 0
      ? []
      : [`Ageing`, ...metrics.ages.map((entry) => `  ${entry.id} ${entry.days}d ${entry.overSle ? '(past SLE) ' : ''}${entry.title}`)]),
  ];
  out(parsed, lines.join('\n'), metrics);
}

function commandBoard(parsed: Parsed, board: ReturnType<typeof openBoard>): void {
  const dow = readDow(board);
  const views = listViews(board);
  const templates = listTemplates(board);
  const lines = [
    `board          ${readBoardTitle(board)} · rev ${boardRevision(board)}`,
    `db             ${board.path}`,
    `WIP control    ${Object.entries(dow.wip).map(([state, limit]) => `${state} ${limit}`).join(', ')} · ready cap ${dow.readyCap}`,
    `SLE            ${Math.round(dow.sle.p * 100)}% ≤ ${dow.sle.days}d (${dow.sle.source})`,
    `DoR            ${dow.dor.join(', ')}`,
    `DoD            ${dow.dod.join(', ')}`,
    `views          ${views.map((view) => view.id).join(', ') || '—'}`,
    `templates      ${templates.map((template) => template.id).join(', ') || '—'}`,
    ...Object.entries(dow.policies).map(([state, policy]) => `policy ${state.padEnd(12)} ${policy}`),
  ];
  out(parsed, lines.join('\n'), { dow, views, templates, rev: boardRevision(board), db: board.path });
}

// --------------------------------------------------------------------------- main

function main(): number {
  let parsed: Parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return EXIT.invalid;
  }

  if (parsed.command === 'help' || parsed.flags.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }

  const dbPath = flagString(parsed, 'db') ?? defaultBoardPath();
  const board = openBoard(dbPath);

  try {
    switch (parsed.command) {
      case 'list': commandList(parsed, board); break;
      case 'show': commandShow(parsed, board); break;
      case 'add': commandAdd(parsed, board); break;
      case 'update': commandUpdate(parsed, board); break;
      case 'move': commandMove(parsed, board); break;
      case 'check': commandCheck(parsed, board); break;
      case 'block': commandBlockish(parsed, board, 'block'); break;
      case 'unblock': commandBlockish(parsed, board, 'unblock'); break;
      case 'purge': commandBlockish(parsed, board, 'purge'); break;
      case 'comment': commandBlockish(parsed, board, 'comment'); break;
      case 'drop': {
        const id = parsed.positional[0];
        if (id === undefined) throw new InvalidError('drop needs a card id');
        const task = moveTask(board, { id, toState: 'dropped', reason: flagString(parsed, 'reason') ?? '' }, { actor: actorFrom(parsed), now: new Date() });
        out(parsed, `${task.id} dropped: ${task.droppedReason ?? ''}`, task);
        break;
      }
      case 'sprint': commandSprint(parsed, board); break;
      case 'metrics': commandMetrics(parsed, board); break;
      case 'board': commandBoard(parsed, board); break;
      case 'where':
        out(parsed, `${dbPath}${dbPath === defaultBoardPath() ? '  (default)' : ''}`, { db: dbPath });
        break;
      default:
        process.stderr.write(`unknown command ${JSON.stringify(parsed.command)}\n\n${USAGE}\n`);
        return EXIT.usage;
    }

    return EXIT.ok;
  } catch (error) {
    if (error instanceof PolicyViolation) {
      process.stderr.write(`refused: ${error.message}\n`);
      if (error.missing.length > 0) process.stderr.write(`missing: ${error.missing.join(', ')}\n`);
      return EXIT.policy;
    }
    if (error instanceof ConflictError) {
      process.stderr.write(`conflict: ${error.message}\n`);
      return EXIT.conflict;
    }
    if (error instanceof NotFoundError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT.notFound;
    }
    if (error instanceof InvalidError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT.invalid;
    }
    if (error instanceof StoreError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return EXIT.invalid;
    }
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    return EXIT.invalid;
  } finally {
    board.close();
  }
}

process.exit(main());
