/**
 * The real host wiring: open the board, claim the route, and register the tools and the skill.
 *
 * Everything here is written to be *idempotent and observable*. Each registration is attempted
 * independently and its outcome recorded, because a plugin whose tools registered but whose route
 * collided is a plugin that must say so rather than one that half-works in silence.
 */
import type { DshHostContext } from '../types/dsh.js';
import { boardRevision, listTasks, openBoard, type Board } from '../store/index.js';
import { API_PREFIX, createApiHandler } from './api.js';
import { readConfig } from './config.js';
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE } from './skill.js';
import { createTools, toolSchemaIssues } from './tools.js';
import { reloadPlugin } from './reload.js';
import type { ProbeRecord } from './probe.js';

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
        reload: () => reloadPlugin(ctx, 'kanban'),
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
  for (const definition of createTools({ board, config: () => config })) {
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

  next = { ...next, status: 'ok', skill, tools: registeredTools };
  return next;
}
