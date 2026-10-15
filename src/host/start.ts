/**
 * The real host wiring: open the board, claim the route, register the tools and the skill, and
 * keep the generated Markdown in step.
 *
 * Everything here is written to be *idempotent and observable*. Each registration is attempted
 * independently and its outcome recorded, because a plugin whose tools registered but whose route
 * collided is a plugin that must say so rather than one that half-works in silence.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DshHostContext, DshWebServerService } from '../types/dsh.js';
import {
  boardRevision,
  computeFlowMetrics,
  importTodoMd,
  listTasks,
  openBoard,
  readBoardTitle,
  readDow,
  renderTodoMd,
  type Board,
} from '../store/index.js';
import { API_PREFIX, createApiHandler } from './api.js';
import { readConfig, type KanbanConfig } from './config.js';
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE } from './skill.js';
import { createTools } from './tools.js';
import type { ProbeRecord } from './probe.js';

/**
 * The Markdown mirror, debounced.
 *
 * A drag across three columns is three mutations; rendering the whole board three times to produce
 * the same file is waste. 400 ms is long enough to coalesce a burst and short enough that nobody
 * notices. The write is atomic (temp file, then `rename`) so a reader never sees half a board.
 */
function createMirror(config: KanbanConfig, board: () => Board): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const write = (): void => {
    try {
      const handle = board();
      const listed = listTasks(handle, { limit: 500 });
      const dow = readDow(handle);
      const markdown = renderTodoMd({
        tasks: listed.tasks,
        dow,
        metrics: computeFlowMetrics({
          tasks: listed.tasks,
          now: new Date(),
          dow,
          boardRev: boardRevision(handle),
        }),
        boardTitle: readBoardTitle(handle),
        boardRev: boardRevision(handle),
        generatedAt: new Date().toISOString(),
        invalid: listed.invalid,
        total: listed.total,
      });
      mkdirSync(dirname(config.mirrorPath), { recursive: true });
      const temporary = `${config.mirrorPath}.tmp`;
      writeFileSync(temporary, markdown, 'utf8');
      renameSync(temporary, config.mirrorPath);
    } catch {
      // The mirror is a view. A failure to write it must never take the board down with it.
    }
  };

  return (): void => {
    if (!config.mirror) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(write, 400);
    if (typeof timer.unref === 'function') timer.unref();
  };
}

/** The startup import of a pre-Kanban `todo.md`, once, when the board is still empty. */
function importLegacyBoard(board: Board, config: KanbanConfig, record: ProbeRecord): ProbeRecord {
  if (!config.importTodoMd || !existsSync(config.mirrorPath)) return record;
  try {
    const existing = listTasks(board, { limit: 1 });
    if (existing.total > 0) return record;
    const text = readFileSync(config.mirrorPath, 'utf8');
    const result = importTodoMd(board, text, { actor: { kind: 'plugin', id: 'kanban-import' }, now: new Date() });
    return { ...record, warnings: [...record.warnings, `imported ${result.imported.length} row(s) from ${config.mirrorPath}`] };
  } catch (error) {
    return {
      ...record,
      warnings: [...record.warnings, `todo.md import failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/** Wire everything, and return the probe record describing what happened. */
export function start(ctx: DshHostContext, record: ProbeRecord, rawConfig: unknown): ProbeRecord {
  const { config, warnings } = readConfig(rawConfig);
  let next: ProbeRecord = { ...record, warnings: [...record.warnings, ...warnings] };

  const handle = openBoard(config.dbPath);
  const board = (): Board => handle;

  next = {
    ...next,
    board: {
      path: config.dbPath,
      opened: true,
      error: null,
      rev: boardRevision(handle),
      tasks: listTasks(handle, { limit: 1 }).total,
    },
  };

  next = importLegacyBoard(handle, config, next);

  // The counts are recorded *after* the import, not before. Reporting `tasks: 0` beside a warning
  // that says thirteen rows were imported is evidence that contradicts itself — and the probe record
  // is the one artifact a reader trusts when nothing else works.
  next = {
    ...next,
    board: {
      ...next.board,
      rev: boardRevision(handle),
      tasks: listTasks(handle, { limit: 1 }).total,
    },
  };

  const mirror = createMirror(config, board);

  // The route. `webServer` is **declared in `inject`**, not looked up: Cordis then waits for it
  // before calling `apply`, which is the difference between registering on a fresh start and
  // silently not registering because the composition had not mounted it yet.
  try {
    const webServer = ctx.webServer;
    if (webServer === undefined) {
      next = { ...next, route: { ...next.route, attempted: false, error: 'ctx.webServer was undefined despite being injected' } };
    } else {
      const handler = createApiHandler({
        board,
        config: () => config,
        buildId: __BUILD_ID__,
        mirror,
        todoMdPath: config.mirrorPath,
      });
      ctx.effect(
        () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
        'dsh-kanban: /api/kanban route'
      );
      next = { ...next, route: { attempted: true, path: API_PREFIX, registered: true, error: null } };
    }
  } catch (error) {
    next = {
      ...next,
      route: {
        attempted: true,
        path: API_PREFIX,
        registered: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  // The tools. Each attempt is recorded, so a partially-registered surface is visible.
  const registeredTools: string[] = [];
  const toolWarnings: string[] = [];
  for (const definition of createTools({ board, config: () => config, mirror })) {
    try {
      ctx.tools.register(definition);
      registeredTools.push(definition.name);
    } catch (error) {
      toolWarnings.push(`${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  next = { ...next, tools: registeredTools, warnings: [...next.warnings, ...toolWarnings] };

  // The skill. Registered in code, so it cannot describe a tool that is not loaded.
  let skill: string | null = null;
  try {
    ctx.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      whenToUse: SKILL_WHEN_TO_USE,
      content: SKILL_CONTENT,
      invocation: { modelInvocable: true, userInvocable: true },
    });
    skill = SKILL_NAME;
  } catch (error) {
    next = {
      ...next,
      warnings: [...next.warnings, `skill registration failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  // One mirror pass at start-up, so the file reflects the store even before the first mutation.
  if (config.mirror) {
    try {
      mirror();
    } catch {
      // Non-fatal by design.
    }
  }

  next = { ...next, status: 'ok', skill, tools: registeredTools };
  return next;
}
