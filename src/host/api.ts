/**
 * The HTTP surface: `/api/kanban/*`, registered on the app's own web server.
 *
 * This is the only way the browser half can write. A profile plugin cannot import
 * `@deepseek-ai/dsh-typert-protocol`, so the typed `@Remote` route the app's own controllers use is
 * closed to us, and the remaining supported seam is the one `dsh-client-connection` itself uses:
 * `ctx.webServer.register({ kind: 'prefix', path, handler })`. A prefix beats the `/api` channel on
 * the server's longest-prefix rule, so these paths are ours and everything else under `/api` still
 * belongs to the app.
 *
 * **Trust, stated plainly.** The server binds loopback only, so a request here comes from this
 * machine. That is the whole fence: an actor header of `human` is believed. It is a deliberate,
 * recorded decision rather than an oversight — the risk it accepts is "another local process could
 * move a card as if it were Dhira", and the thing it protects (the agent/user distinction) is
 * enforced at the *tool* boundary, where an agent's identity is its session, not a header. A
 * cryptographic token is the obvious hardening and is deferred until the index-injection question
 * for a `file://`-loaded window is answered, because a token the panel cannot read would break the
 * panel rather than harden it.
 */
import type { DshIncomingMessage, DshServerResponse, DshWebRoute } from '../types/dsh.js';
import type { Board } from '../store/db.js';
import {
  ConflictError,
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
  saveTemplate,
  saveView,
  setCheck,
  startSprint,
  unblockTask,
  updateTask,
  writeDow,
} from '../store/index.js';
import { HUMAN, type Actor, type State, type TaskFilter } from '../store/types.js';
import type { KanbanConfig } from './config.js';
import type { ProbeRecord } from './probe.js';

/** `webServer.register` route prefix. Everything the panel calls lives under it. */
export const API_PREFIX = '/api/kanban';

const MAX_BODY_BYTES = 1_048_576;

export interface ApiDeps {
  readonly board: () => Board;
  readonly config: () => KanbanConfig;
  readonly buildId: string;
  readonly mirror: () => void;
  readonly todoMdPath: string;
}

function send(res: DshServerResponse, status: number, body: string, contentType = 'application/json; charset=utf-8'): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res: DshServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value));
}

function header(req: DshIncomingMessage, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Who is asking. The panel is the human's surface and says so; a script may claim `cli`; an agent
 * names its session. Defaulting to `human` rather than `agent` is the permissive choice, and it is
 * the one the trust model above already accepts.
 */
function actorFrom(req: DshIncomingMessage): Actor {
  const raw = header(req, 'x-kanban-actor') ?? 'human';
  if (raw === 'human') return HUMAN;
  if (raw === 'cli') return { kind: 'cli', id: 'cli' };
  if (raw.startsWith('agent:')) return { kind: 'agent', id: raw.slice('agent:'.length) };
  return { kind: 'agent', id: raw };
}

function readBody(req: DshIncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.from(chunk ?? new Uint8Array());
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!settled) reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function bool(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

function num(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The board payload the panel renders, and the ETag the client polls against. */
function boardPayload(deps: ApiDeps, options: { readonly includeAll: boolean }): Record<string, unknown> {
  const board = deps.board();
  const now = new Date();
  const dow = readDow(board);
  const listed = listTasks(board, { limit: 500 });
  const metrics = computeFlowMetrics({ tasks: listed.tasks, now, dow, boardRev: boardRevision(board) });

  return {
    rev: boardRevision(board),
    title: readBoardTitle(board),
    dow,
    tasks: listed.tasks,
    metrics,
    counts: countsByState(board),
    views: listViews(board),
    templates: listTemplates(board),
    sprints: listSprints(board),
    invalid: listed.invalid,
    total: listed.total,
    servedAt: now.toISOString(),
    buildId: deps.buildId,
    ...(options.includeAll ? {} : {}),
  };
}

/** One mutation, dispatched by `op`. Each handler is a thin, typed wrapper over the repository. */
function applyOp(
  deps: ApiDeps,
  op: string,
  payload: Record<string, unknown>,
  actor: Actor
): unknown {
  const board = deps.board();
  const now = new Date();

  switch (op) {
    case 'create': {
      const input = asRecord(payload.input);
      return createTask(
        board,
        {
          title: str(input, 'title') ?? '',
          ...(str(input, 'outcome') === undefined ? {} : { outcome: str(input, 'outcome') }),
          ...(str(input, 'description') === undefined ? {} : { description: str(input, 'description') }),
          ...(str(input, 'acceptance') === undefined ? {} : { acceptance: str(input, 'acceptance') }),
          ...(str(input, 'priority') === undefined ? {} : { priority: str(input, 'priority') as never }),
          ...(str(input, 'classOfService') === undefined ? {} : { classOfService: str(input, 'classOfService') as never }),
          ...(str(input, 'assignee') === undefined ? {} : { assignee: str(input, 'assignee') }),
          ...(str(input, 'project') === undefined ? {} : { project: str(input, 'project') }),
          ...(str(input, 'workspace') === undefined ? {} : { workspace: str(input, 'workspace') }),
          ...(str(input, 'folder') === undefined ? {} : { folder: str(input, 'folder') }),
          ...(num(input, 'estimate') === undefined ? {} : { estimate: num(input, 'estimate') }),
        },
        { actor, now }
      );
    }

    case 'update': {
      const id = str(payload, 'id');
      if (id === undefined) throw new Error('update needs an id');
      const patch = asRecord(payload.patch);
      const expectedRev = num(payload, 'expectedRev');
      const task = updateTask(
        board,
        id,
        patch as never,
        expectedRev === undefined ? { actor, now } : { actor, now, expectedRev }
      );
      deps.mirror();
      return task;
    }

    case 'move': {
      const id = str(payload, 'id');
      const toState = str(payload, 'toState');
      if (id === undefined || toState === undefined) throw new Error('move needs an id and a toState');
      const task = moveTask(
        board,
        {
          id,
          toState: toState as State,
          ...(num(payload, 'toPosition') === undefined ? {} : { toPosition: num(payload, 'toPosition') as number }),
          ...(num(payload, 'expectedRev') === undefined ? {} : { expectedRev: num(payload, 'expectedRev') as number }),
          ...(bool(payload, 'force') === undefined ? {} : { force: bool(payload, 'force') as boolean }),
          ...(str(payload, 'reason') === undefined ? {} : { reason: str(payload, 'reason') as string }),
        },
        { actor, now }
      );
      deps.mirror();
      return task;
    }

    case 'block': {
      const id = str(payload, 'id');
      const reason = str(payload, 'reason') ?? '';
      if (id === undefined) throw new Error('block needs an id');
      const task = blockTask(board, id, reason, { actor, now });
      deps.mirror();
      return task;
    }

    case 'unblock': {
      const id = str(payload, 'id');
      if (id === undefined) throw new Error('unblock needs an id');
      const task = unblockTask(board, id, { actor, now });
      deps.mirror();
      return task;
    }

    case 'check': {
      const id = str(payload, 'id');
      const gate = str(payload, 'gate');
      const checkId = str(payload, 'checkId');
      const done = bool(payload, 'done') ?? true;
      if (id === undefined || (gate !== 'dor' && gate !== 'dod') || checkId === undefined) {
        throw new Error('check needs an id, a gate of dor|dod, and a checkId');
      }
      const task = setCheck(board, id, gate, checkId, done, { actor, now });
      deps.mirror();
      return task;
    }

    case 'comment': {
      const id = str(payload, 'id');
      const body = str(payload, 'body') ?? '';
      if (id === undefined) throw new Error('comment needs an id');
      return addComment(board, id, body, { actor, now });
    }

    case 'purge': {
      const id = str(payload, 'id');
      if (id === undefined) throw new Error('purge needs an id');
      purgeTask(board, id, { actor, now });
      deps.mirror();
      return { purged: id };
    }

    case 'sprint-create': {
      const start = str(payload, 'start');
      const end = str(payload, 'end');
      if (start === undefined || end === undefined) throw new Error('sprint-create needs start and end');
      const sprint = createSprint(
        board,
        { name: str(payload, 'name') ?? 'Sprint', goal: str(payload, 'goal') ?? '', start, end },
        { actor, now }
      );
      deps.mirror();
      return sprint;
    }

    case 'sprint-start': {
      const id = str(payload, 'id');
      if (id === undefined) throw new Error('sprint-start needs an id');
      return startSprint(board, id, { actor, now });
    }

    case 'sprint-close': {
      const id = str(payload, 'id');
      if (id === undefined) throw new Error('sprint-close needs an id');
      const result = closeSprint(board, id, { actor, now });
      deps.mirror();
      return result;
    }

    case 'sprint-cancel': {
      const id = str(payload, 'id');
      if (id === undefined) throw new Error('sprint-cancel needs an id');
      return cancelSprint(board, id, str(payload, 'reason') ?? '', { actor, now });
    }

    case 'template-save': {
      const id = str(payload, 'id');
      if (id === undefined) throw new Error('template-save needs an id');
      return saveTemplate(
        board,
        {
          id,
          name: str(payload, 'name') ?? id,
          description: str(payload, 'description') ?? '',
          patch: asRecord(payload.patch) as never,
        },
        { actor, now }
      );
    }

    case 'view-save': {
      const id = str(payload, 'id');
      if (id === undefined) throw new Error('view-save needs an id');
      return saveView(
        board,
        {
          id,
          name: str(payload, 'name') ?? id,
          description: str(payload, 'description') ?? '',
          filter: asRecord(payload.filter) as TaskFilter,
          groupBy: (str(payload, 'groupBy') ?? 'state') as never,
        },
        { actor, now }
      );
    }

    case 'import-todo': {
      const text = str(payload, 'text');
      if (text === undefined) throw new Error('import-todo needs the markdown text');
      const result = importTodoMd(board, text, { actor, now });
      deps.mirror();
      return result;
    }

    case 'set-dow': {
      const dow = asRecord(payload.dow);
      writeDow(board, dow as never);
      deps.mirror();
      return readDow(board);
    }

    case 'mirror': {
      deps.mirror();
      return { mirrored: true };
    }

    default:
      throw new Error(`unknown op ${JSON.stringify(op)}`);
  }
}

function statusFor(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof PolicyViolation) {
    return {
      status: 422,
      body: { ok: false, code: error.policyCode, message: error.message, missing: error.missing },
    };
  }
  if (error instanceof ConflictError) {
    return {
      status: 409,
      body: { ok: false, code: 'conflict', message: error.message, current: error.current },
    };
  }
  if (error instanceof NotFoundError) {
    return { status: 404, body: { ok: false, code: error.code, message: error.message } };
  }
  if (error instanceof StoreError) {
    return { status: error.code === 'invalid' ? 400 : 500, body: { ok: false, code: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 400, body: { ok: false, code: 'bad-request', message } };
}

/** The route handler. Never throws: a thrown handler would be answered `400` by the server anyway. */
export function createApiHandler(deps: ApiDeps): DshWebRoute['handler'] {
  return async function handle(req: DshIncomingMessage, res: DshServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? API_PREFIX, 'http://127.0.0.1');
    const path = url.pathname;

    if (!path.startsWith(API_PREFIX)) {
      sendJson(res, 404, { ok: false, code: 'not-found', message: `nothing at ${path}` });
      return;
    }
    const route = path.slice(API_PREFIX.length).replace(/\/+$/, '') || '/';

    try {
      if (route === '/health') {
        const board = deps.board();
        sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-kanban',
          buildId: deps.buildId,
          node: process.versions.node,
          electron: process.versions.electron ?? null,
          api: API_PREFIX,
          method,
          board: { path: deps.config().dbPath, rev: boardRevision(board), tasks: countsByState(board) },
        });
        return;
      }

      if (route === '/board' && method === 'GET') {
        const board = deps.board();
        const rev = boardRevision(board);
        if (url.searchParams.get('since') === String(rev)) {
          send(res, 304, '');
          return;
        }
        sendJson(res, 200, { ok: true, board: boardPayload(deps, { includeAll: true }), rev });
        return;
      }

      if (route.startsWith('/task/') && method === 'GET') {
        const id = decodeURIComponent(route.slice('/task/'.length));
        const board = deps.board();
        const task = getTask(board, id);
        if (task === undefined) {
          sendJson(res, 404, { ok: false, code: 'not-found', message: `no task ${id}` });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          task,
          comments: listComments(board, id),
          events: listEvents(board, { taskId: id, limit: 100 }),
        });
        return;
      }

      if (route === '/export' && method === 'GET') {
        const board = deps.board();
        const listed = listTasks(board, { limit: 500 });
        const markdown = renderTodoMd({
          tasks: listed.tasks,
          dow: readDow(board),
          metrics: computeFlowMetrics({
            tasks: listed.tasks,
            now: new Date(),
            dow: readDow(board),
            boardRev: boardRevision(board),
          }),
          boardTitle: readBoardTitle(board),
          boardRev: boardRevision(board),
          generatedAt: new Date().toISOString(),
          invalid: listed.invalid,
        });
        send(res, 200, markdown, 'text/markdown; charset=utf-8');
        return;
      }

      if (route === '/mutate' && method === 'POST') {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = raw.length === 0 ? {} : JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, code: 'bad-json', message: 'the body is not valid JSON' });
          return;
        }
        const body = asRecord(parsed);
        const op = str(body, 'op');
        if (op === undefined) {
          sendJson(res, 400, { ok: false, code: 'bad-request', message: 'the body needs an op' });
          return;
        }
        const actor = actorFrom(req);
        const result = applyOp(deps, op, body, actor);
        sendJson(res, 200, { ok: true, rev: boardRevision(deps.board()), op, result });
        return;
      }

      sendJson(res, 404, { ok: false, code: 'not-found', message: `no route for ${method} ${route}` });
    } catch (error) {
      const { status, body } = statusFor(error);
      sendJson(res, status, body);
    }
  };
}

/** The probe summary this module contributes. */
export function apiProbe(): ProbeRecord['route'] {
  return { attempted: true, path: `${API_PREFIX}`, registered: false, error: null };
}
