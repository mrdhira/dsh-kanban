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
  filterCards,
  positionForIndex,
  type BoardPayload,
  type ViewFilter,
} from './model.js';
import { STATE_LABEL, type CheckId, type State, type Task } from '../store/types.js';

export type BoardStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface Notice {
  readonly kind: 'refusal' | 'info' | 'error';
  readonly message: string;
  readonly missing?: readonly string[];
  /** Bumped every time, so an identical refusal still re-renders and re-announces. */
  readonly at: number;
}

/**
 * A move the panel is holding open instead of sending: the drawer's drop, staged.
 *
 * A drag onto Dropped (or a keyboard move that lands there) cannot carry the reason the gate
 * requires, so the panel does not send a move at all — it opens the card's drawer with the drop
 * staged and the reason field focused, and nothing reaches the store until the human confirms. The
 * state lives here rather than inside the drawer because the drawer is keyed by card: it mounts
 * fresh when the gesture opens it, and a card-keyed local would have to be seeded before the mount.
 */
export interface StagedDrop {
  readonly taskId: string;
  /** Which gesture staged it, so the drawer knows whether to claim the keyboard for the field. */
  readonly via: 'pointer' | 'keyboard';
  /**
   * The drop index the pointer chose, when a drag staged it.
   *
   * The gesture already decided *where* in the lane the card belongs; only the reason is missing.
   * Without this the confirmed drop would land at the end of the lane and the gap the human aimed
   * at would be forgotten between the gesture and the confirmation.
   */
  readonly index?: number;
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
  /** Set while a drop is staged in the drawer; null otherwise. */
  readonly stagedDrop: StagedDrop | null;
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
  /** Open the card's drawer with its drop staged; nothing is sent until the human confirms. */
  stageDrop(id: string, via: StagedDrop['via'], index?: number): Promise<void>;
  notice(message: string | null, kind?: Notice['kind'], missing?: readonly string[]): void;
  /**
   * Create a card and say whether the host accepted it.
   *
   * The dialog closes on `true` and stays open on `false` with the store's refusal visible, so the
   * answer has to reach the caller; the old disclosure's row vanished either way, and a refusal left
   * the human with a notice and no form.
   */
  create(title: string, extra?: Record<string, unknown>): Promise<boolean>;
  move(id: string, toState: State, index?: number, options?: MoveOptions): Promise<void>;
  tick(id: string, gate: 'dor' | 'dod', checkId: CheckId, done: boolean): Promise<void>;
  patch(id: string, patch: Record<string, unknown>): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  block(id: string, reason: string): Promise<void>;
  unblock(id: string): Promise<void>;
  drop(id: string, reason: string, index?: number): Promise<void>;
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
    stagedDrop: null,
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
      // The **answer** decides, not the call: the timer's read is not the write's read, so when one
      // lands while `busy` is set it must neither end the write's pending treatment nor put the
      // board-as-of-that-read back over the optimistic payload — that is how a card the human just
      // moved snapped back. Only a caller that already owns the read (`force`) is let through: the
      // header's Refresh, `start`'s first read, and the write's own read after the host answers.
      // Overwriting the optimistic payload needs a concurrent *external* change to the same board to
      // be visible, so that half is a risk; the `busy` half needs no second writer.
      if (state.busy && !force) return;
      if (!answer.changed || answer.payload === undefined) {
        // Nothing moved: keep the identical snapshot so React does no work.
        if (state.status !== 'ready' && state.payload !== null) set({ status: 'ready' });
        return;
      }
      set({ status: 'ready', payload: answer.payload, lastError: null });
    } catch (error) {
      // `busy` is not cleared here either: it belongs to the write that set it, and that write clears
      // it when the host answers. A poll that failed mid-write is not that answer.
      set({
        status: state.payload === null ? 'error' : 'ready',
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Whether a select is already open on `id`, so the drawer need not be re-opened for a stage. */
  function isSelected(id: string): boolean {
    return state.selectedId === id;
  }

  /** Run one write: apply locally, ask the host, roll back and report if it says no. Returns whether it landed. */
  async function write(op: string, payload: Record<string, unknown>, optimistic?: () => BoardPayload | null): Promise<boolean> {
    const previous = state.payload;
    const optimisticNext = optimistic?.() ?? null;
    if (optimisticNext !== null) set({ payload: optimisticNext, busy: true, notice: null });
    else set({ busy: true, notice: null });

    try {
      await transport.mutate(op, payload);
      await refresh(true);
      set({ busy: false });
      return true;
    } catch (error) {
      // Roll back to what the host still believes, then say why.
      set({ payload: previous, busy: false, notice: refusalNotice(error) });
      await refresh(true);
      return false;
    }
  }

  /**
   * The store, named so the returned methods can call one another without `this`.
   *
   * `stageDrop` is `select` plus the staged record; a destructured `this` would break the moment a
   * caller passed `store.stageDrop` around, and the rest of this file already avoids the receiver.
   */
  const store: BoardStore = {
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
        set({ selectedId: null, detail: null, stagedDrop: null });
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

    /**
     * Stage a drop: select the card and record the gesture, in that order.
     *
     * The drawer renders off `selectedId`, so selecting is what opens it; `stagedDrop` tells it to
     * open the destructive group and focus the reason field. An unchanged pair does nothing, so a
     * repeated `dragover`/`drop` on Dropped cannot re-render the board for no reason.
     */
    async stageDrop(id, via, index) {
      const staged: StagedDrop = { taskId: id, via, ...(index === undefined ? {} : { index }) };
      const current = state.stagedDrop;
      if (
        current?.taskId === staged.taskId &&
        current.via === staged.via &&
        current.index === staged.index &&
        isSelected(id)
      ) {
        return;
      }
      set({ stagedDrop: staged });
      await store.select(id);
    },

    notice(message, kind = 'info', missing) {
      noticeSeq += 1;
      set({
        notice: message === null ? null : { kind, message, ...(missing === undefined ? {} : { missing }), at: noticeSeq },
      });
    },

    async create(title, extra) {
      const trimmed = title.trim();
      if (trimmed.length === 0) return false;
      // No optimistic card here: the host assigns the id, and a placeholder with a guessed id would
      // have to be reconciled against the real one. A create is fast enough to wait for.
      return write('create', { input: { title: trimmed, ...extra } });
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

    async drop(id, reason, index) {
      const payload = state.payload;
      const task = payload?.tasks.find((entry) => entry.id === id);
      // Where the card lands: the pointer's own index when a drag staged this drop, otherwise the
      // card's current position (a drop from the drawer's own Drop control reorders nothing).
      const position =
        index === undefined
          ? (task?.position ?? 0)
          : positionForIndex(
              [...(payload?.tasks ?? [])].filter((entry) => entry.state === 'dropped').filter((entry) => entry.id !== id),
              index
            );
      const landed = await write(
        'move',
        { id, toState: 'dropped', toPosition: position, reason, ...(task === undefined ? {} : { expectedRev: task.rev }) },
        payload === null ? undefined : () => applyLocalMove(payload, id, 'dropped', position, now().toISOString())
      );
      // Dropping is the one move that takes a card out of play, and the board said nothing: the only
      // feedback was `showing X of Y` ticking down, and the card moved to a lane nobody had a control
      // for. A successful drop now acknowledges where the card went, in the strip that already
      // carries every other thing the panel has to say — and since the board draws every state, that
      // lane is on screen without anyone asking for it. A refusal keeps its own notice.
      if (landed) {
        noticeSeq += 1;
        set({
          notice: {
            kind: 'info',
            message: `${id} dropped — still on the board, under ${STATE_LABEL.dropped}`,
            at: noticeSeq,
          },
        });
      }
    },

    async purge(id) {
      await write('purge', { id });
    },
  };

  return store;
}

/** The card the drawer is showing, from the snapshot. */
export function selectedTask(state: BoardState): Task | undefined {
  if (state.selectedId === null || state.payload === null) return undefined;
  return state.payload.tasks.find((task) => task.id === state.selectedId);
}
