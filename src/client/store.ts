/**
 * The panel's store: one observable object, optimistic writes, and a polling cursor.
 *
 * Two rules this file exists to obey, both learned the expensive way:
 *
 * 1. **`getSnapshot` must return the same reference until something actually changed.** It feeds
 *    `useSyncExternalStore`, which compares snapshots by reference; a defensive copy per call once
 *    produced "Maximum update depth exceeded". A 304 from the poll therefore leaves the state
 *    object untouched — that is what makes polling free.
 * 2. **A refusal must be visible and reversible.** Every write is applied locally first so the drag
 *    lands instantly, and rolled back with the host's own message when the host says no. The host
 *    is authoritative; the optimistic view is a courtesy.
 *
 * No React here either: the store is a plain object so its optimistic/rollback behaviour can be
 * tested without a DOM, and the hook that wires it to React is three lines.
 */
import { Refusal, type BoardTransport, type OriginInfo, type TaskDetail } from './api.js';
import {
  applyLocalMove,
  checkMoveLocally,
  columnsOf,
  filterCards,
  positionForIndex,
  type BoardPayload,
  type ViewFilter,
} from './model.js';
import type { CheckId, State, Task } from '../store/types.js';

export type BoardStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface Notice {
  readonly kind: 'refusal' | 'info' | 'error';
  readonly message: string;
  readonly missing?: readonly string[];
  /** Bumped every time, so an identical refusal still re-renders and re-announces. */
  readonly at: number;
}

export interface BoardState {
  readonly status: BoardStatus;
  readonly payload: BoardPayload | null;
  readonly filter: ViewFilter;
  readonly selectedId: string | null;
  readonly detail: TaskDetail | null;
  readonly notice: Notice | null;
  readonly origin: OriginInfo;
  readonly busy: boolean;
  readonly lastError: string | null;
}

/**
 * The two things an agent's `kanban_move` can send that a bare drag cannot: an explicit
 * `position`, a written exception. They ride on the same call so the pointer, the keyboard and
 * the panel's Exception control all pass through `checkMoveLocally` and the host's `checkMove`.
 */
export interface MoveOptions {
  /**
   * Ask to except a gate. This is a *request*, not a forwarded flag: `move` sends `force` only when
   * the ordinary gates refuse the move and the exception allows it, so the host records a
   * `GateException` only for a gate that was actually excepted. The reason is required.
   */
  readonly force?: boolean;
  /** Required when dropping, reopening a finished card, or forcing a move. */
  readonly reason?: string;
  /** Order inside the target column, exactly as `kanban_move.toPosition` means it. */
  readonly position?: number;
}

export interface BoardStore {
  getSnapshot(): BoardState;
  subscribe(listener: () => void): () => void;
  /** Begin polling; returns the stop function. */
  start(): () => void;
  refresh(force?: boolean): Promise<void>;
  setFilter(filter: ViewFilter): void;
  select(id: string | null): Promise<void>;
  notice(message: string | null, kind?: Notice['kind'], missing?: readonly string[]): void;
  create(title: string, extra?: Record<string, unknown>): Promise<void>;
  move(id: string, toState: State, index?: number, options?: MoveOptions): Promise<void>;
  tick(id: string, gate: 'dor' | 'dod', checkId: CheckId, done: boolean): Promise<void>;
  patch(id: string, patch: Record<string, unknown>): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  block(id: string, reason: string): Promise<void>;
  unblock(id: string): Promise<void>;
  drop(id: string, reason: string): Promise<void>;
  purge(id: string): Promise<void>;
}

export interface BoardStoreOptions {
  readonly now?: () => Date;
  readonly pollMs?: number;
  /** Whether the panel is on screen; polling stops when it is not. */
  readonly visible?: () => boolean;
}

export function createBoardStore(transport: BoardTransport, options: BoardStoreOptions = {}): BoardStore {
  const now = options.now ?? ((): Date => new Date());
  const pollMs = options.pollMs ?? 5000;
  const visible = options.visible ?? ((): boolean => true);

  let state: BoardState = {
    status: 'idle',
    payload: null,
    filter: {},
    selectedId: null,
    detail: null,
    notice: null,
    origin: transport.origin,
    busy: false,
    lastError: null,
  };

  const listeners = new Set<() => void>();
  let noticeSeq = 0;
  let stopped = false;

  /** The only place `state` is replaced, so every change is a new reference and nothing else is. */
  function set(partial: Partial<BoardState>): void {
    state = { ...state, ...partial };
    for (const listener of listeners) listener();
  }

  function refusalNotice(error: unknown): Notice {
    noticeSeq += 1;
    if (error instanceof Refusal) {
      return {
        kind: 'refusal',
        message: error.message,
        ...(error.missing.length === 0 ? {} : { missing: error.missing }),
        at: noticeSeq,
      };
    }
    return { kind: 'error', message: error instanceof Error ? error.message : String(error), at: noticeSeq };
  }

  async function refresh(force = false): Promise<void> {
    const since = force ? undefined : state.payload?.rev;
    try {
      const answer = await transport.board(since);
      if (!answer.changed || answer.payload === undefined) {
        // Nothing moved: keep the identical snapshot so React does no work.
        if (state.status !== 'ready' && state.payload !== null) set({ status: 'ready' });
        return;
      }
      set({ status: 'ready', payload: answer.payload, lastError: null, busy: false });
    } catch (error) {
      set({
        status: state.payload === null ? 'error' : 'ready',
        lastError: error instanceof Error ? error.message : String(error),
        busy: false,
      });
    }
  }

  /** Run one write: apply locally, ask the host, roll back and report if it says no. */
  async function write(op: string, payload: Record<string, unknown>, optimistic?: () => BoardPayload | null): Promise<void> {
    const previous = state.payload;
    const optimisticNext = optimistic?.() ?? null;
    if (optimisticNext !== null) set({ payload: optimisticNext, busy: true, notice: null });
    else set({ busy: true, notice: null });

    try {
      await transport.mutate(op, payload);
      await refresh(true);
      set({ busy: false });
    } catch (error) {
      // Roll back to what the host still believes, then say why.
      set({ payload: previous, busy: false, notice: refusalNotice(error) });
      await refresh(true);
    }
  }

  return {
    getSnapshot: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      stopped = false;
      set({ status: state.payload === null ? 'loading' : state.status });
      void refresh(true);
      const timer = setInterval(() => {
        if (!stopped && visible()) void refresh(false);
      }, pollMs);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },

    refresh,

    setFilter(filter) {
      set({ filter });
    },

    async select(id) {
      if (id === null) {
        set({ selectedId: null, detail: null });
        return;
      }
      set({ selectedId: id, detail: null });
      try {
        const detail = await transport.task(id);
        // The human may have clicked a second card while this was in flight.
        if (state.selectedId === id) set({ detail });
      } catch (error) {
        set({ notice: refusalNotice(error) });
      }
    },

    notice(message, kind = 'info', missing) {
      noticeSeq += 1;
      set({
        notice: message === null ? null : { kind, message, ...(missing === undefined ? {} : { missing }), at: noticeSeq },
      });
    },

    async create(title, extra) {
      const trimmed = title.trim();
      if (trimmed.length === 0) return;
      // No optimistic card here: the host assigns the id, and a placeholder with a guessed id would
      // have to be reconciled against the real one. A create is fast enough to wait for.
      await write('create', { input: { title: trimmed, ...extra } });
    },

    async move(id, toState, index, options) {
      const payload = state.payload;
      if (payload === null) return;
      const task = payload.tasks.find((entry) => entry.id === id);
      if (task === undefined) return;

      const reason = options?.reason;
      const withReason = reason === undefined ? {} : { reason };
      // Evaluate the ordinary gates first. A move they already allow is **not** an exception, even
      // when the human reached it through the Exception control: `done → x` passes `policy.checkMove`
      // on the reason alone, so forwarding `force` blindly made every panel reopen append a
      // `GateException` and an `exception` event that the same `kanban_move` never writes — and that
      // log is what the four flow metrics and "recomputable from the log" rest on.
      const plain = checkMoveLocally({ payload, task, toState, ...withReason });
      const forced =
        options?.force === true ? checkMoveLocally({ payload, task, toState, force: true, ...withReason }) : null;
      // Only a move the ordinary gates refuse *and* the exception allows is an exception to send.
      const exception = forced !== null && forced.ok && !plain.ok;
      if (!exception) {
        // When an exception was asked for and even that would be refused, its message ("an exception
        // needs a written reason") is the more useful of the two.
        const refusal = plain.ok ? plain : (forced ?? plain);
        if (!refusal.ok) {
          set({ notice: refusalNotice(new Refusal(422, 'policy', refusal.reason, refusal.missing ?? [])) });
          return;
        }
      }

      const target = filterCards(payload.tasks, { state: [toState] }).filter((entry) => entry.id !== id);
      // An explicit position is the agent's `toPosition`: it is the order itself, not a drop index.
      const position =
        options?.position ??
        (task.state === toState && index === undefined ? task.position : positionForIndex(target, index ?? target.length));

      await write(
        'move',
        {
          id,
          toState,
          toPosition: position,
          expectedRev: task.rev,
          ...(exception ? { force: true } : {}),
          ...withReason,
        },
        () => applyLocalMove(payload, id, toState, position, now().toISOString())
      );
    },

    async tick(id, gate, checkId, done) {
      const payload = state.payload;
      const task = payload?.tasks.find((entry) => entry.id === id);
      await write('check', { id, gate, checkId, done, ...(task === undefined ? {} : { expectedRev: task.rev }) });
    },

    async patch(id, patch) {
      const task = state.payload?.tasks.find((entry) => entry.id === id);
      await write('update', { id, patch, ...(task === undefined ? {} : { expectedRev: task.rev }) });
    },

    async comment(id, body) {
      await write('comment', { id, body });
    },

    async block(id, reason) {
      await write('block', { id, reason });
    },

    async unblock(id) {
      await write('unblock', { id });
    },

    async drop(id, reason) {
      const payload = state.payload;
      const task = payload?.tasks.find((entry) => entry.id === id);
      await write(
        'move',
        { id, toState: 'dropped', reason, ...(task === undefined ? {} : { expectedRev: task.rev }) },
        payload === null ? undefined : () => applyLocalMove(payload, id, 'dropped', task?.position ?? 0, now().toISOString())
      );
    },

    async purge(id) {
      await write('purge', { id });
    },
  };
}

/** The columns a state renders, for a component that only has the snapshot. */
export function columnsFor(state: BoardState) {
  return state.payload === null ? [] : columnsOf(state.payload, state.filter);
}

/** The card the drawer is showing, from the snapshot. */
export function selectedTask(state: BoardState): Task | undefined {
  if (state.selectedId === null || state.payload === null) return undefined;
  return state.payload.tasks.find((task) => task.id === state.selectedId);
}
