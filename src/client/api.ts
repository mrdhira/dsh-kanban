/**
 * The browser half's transport: where the host is, and how to talk to it.
 *
 * There is no typed `@Remote` for a third-party plugin — a profile plugin cannot import
 * `@deepseek-ai/dsh-typert-protocol` — so the panel speaks to the host over the plugin's own HTTP
 * route, the same `ctx.webServer.register` seam the app's own `/api` bridge uses.
 *
 * The one subtlety is **where** the host is. A bare `fetch('/api/kanban/board')` resolves against
 * the *document* origin, which in the desktop window is `file://` — where a relative API path means
 * nothing. The page transport carries the host's real HTTP origin, so that comes first, then a real
 * `http(s)` document origin, then the packaged default. Which one was used is part of the store's
 * state and is displayed, because "the board is empty" and "the panel asked the wrong server" look
 * identical otherwise.
 */
import type { BoardPayload } from './model.js';
import type { Comment, State, Task, TaskEvent } from '../store/types.js';

export const API_PREFIX = '/api/kanban';

export interface OriginInfo {
  readonly origin: string;
  readonly source: string;
  readonly detail: string;
}

/** Resolve the host origin as the page can see it. Pure, so it is testable without a browser. */
export function resolveOrigin(scope: {
  readonly transport?: { readonly streamBaseUrl?: unknown };
  readonly location?: { readonly protocol?: string; readonly origin?: string; readonly href?: string };
  readonly fallback?: string;
} = {}): OriginInfo {
  const streamBaseUrl = scope.transport?.streamBaseUrl;
  if (typeof streamBaseUrl === 'string' && streamBaseUrl.length > 0) {
    try {
      return { origin: new URL(streamBaseUrl).origin, source: '__DSH_TRANSPORT__.streamBaseUrl', detail: streamBaseUrl };
    } catch {
      /* an unparseable transport origin falls through to the document */
    }
  }
  const location_ = scope.location;
  if (location_?.protocol !== undefined && /^https?:$/.test(location_.protocol) && typeof location_.origin === 'string') {
    return { origin: location_.origin, source: 'location.origin', detail: location_.href ?? location_.origin };
  }
  const fallback = scope.fallback ?? 'http://127.0.0.1:19387';
  return { origin: fallback, source: 'fallback constant', detail: 'no page transport and no http origin' };
}

/**
 * A refusal from the policy engine, or any other non-2xx answer.
 *
 * `missing` carries the unticked checklist ids when the refusal is a gate, so the drawer can open
 * exactly at what is missing rather than making the human hunt for it.
 */
export class Refusal extends Error {
  readonly code: string;
  readonly missing: readonly string[];
  readonly status: number;

  constructor(status: number, code: string, message: string, missing: readonly string[] = []) {
    super(message);
    this.name = 'Refusal';
    this.status = status;
    this.code = code;
    this.missing = missing;
  }
}

export interface TaskDetail {
  readonly task: Task;
  readonly comments: readonly Comment[];
  readonly events: readonly TaskEvent[];
}

export interface MutateOutcome {
  readonly rev: number;
  readonly result: unknown;
}

/** What the panel needs from a transport. Narrow on purpose: a test implements four methods. */
export interface BoardTransport {
  readonly origin: OriginInfo;
  /** `since` is the revision the caller already has; the host answers 304 when nothing moved. */
  board(since?: number): Promise<{ readonly changed: boolean; readonly payload?: BoardPayload }>;
  task(id: string): Promise<TaskDetail>;
  mutate(op: string, payload: Record<string, unknown>): Promise<MutateOutcome>;
  health(): Promise<unknown>;
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

async function readJson<T>(response: Awaited<ReturnType<FetchLike>>, what: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let code = 'http-error';
    let message = `HTTP ${response.status}`;
    let missing: string[] = [];
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string; missing?: string[] };
      if (typeof parsed.code === 'string') code = parsed.code;
      if (typeof parsed.message === 'string') message = parsed.message;
      if (Array.isArray(parsed.missing)) missing = parsed.missing;
    } catch {
      message = text.slice(0, 300) || message;
    }
    throw new Refusal(response.status, code, message, missing);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Refusal(response.status, 'bad-json', `${what} returned something that is not JSON: ${text.slice(0, 200)}`);
  }
}

/** The HTTP transport. `fetchImpl` is injected so a test never needs a network. */
export function createHttpTransport(fetchImpl: FetchLike, origin: OriginInfo, actorHeader = 'human'): BoardTransport {
  const base = `${origin.origin}${API_PREFIX}`;
  const headers = { 'x-kanban-actor': actorHeader, accept: 'application/json' };

  return {
    origin,

    async board(since) {
      const url = since === undefined ? `${base}/board` : `${base}/board?since=${String(since)}`;
      const response = await fetchImpl(url, { headers });
      // 304 is the whole point of polling with a cursor: nothing moved, so the store keeps its
      // current snapshot and React sees the same reference it already had.
      if (response.status === 304) return { changed: false };
      const parsed = await readJson<{ ok: boolean; board: BoardPayload; rev: number }>(response, 'the board');
      return { changed: true, payload: parsed.board };
    },

    async task(id) {
      const parsed = await readJson<{ ok: boolean; task: Task; comments: Comment[]; events: TaskEvent[] }>(
        await fetchImpl(`${base}/task/${encodeURIComponent(id)}`, { headers }),
        'the card'
      );
      return { task: parsed.task, comments: parsed.comments, events: parsed.events };
    },

    async mutate(op, payload) {
      const parsed = await readJson<{ ok: boolean; rev: number; result: unknown }>(
        await fetchImpl(`${base}/mutate`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ op, ...payload }),
        }),
        'the mutation'
      );
      return { rev: parsed.rev, result: parsed.result };
    },

    async health() {
      return readJson<unknown>(await fetchImpl(`${base}/health`, { headers }), 'health');
    },
  };
}

/** The state the drawer may ask for; kept here so the component and the store agree. */
export type { State };
