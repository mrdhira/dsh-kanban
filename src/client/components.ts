/**
 * The board, as React elements.
 *
 * No JSX: the element tree is built with `React.createElement`, which keeps the bundle free of a
 * `react/jsx-runtime` import the browser module table may not expose.
 *
 * **Every sub-view is a real component, rendered with `createElement` — never called as a plain
 * function.** That is not style: `Lane` and `Drawer` use `useRef`/`useState`, and calling a
 * hook-using function inline attributes its hooks to the *caller*, so the first render with three
 * lanes and the next with five throws "Rendered more hooks than during the previous render". The
 * first version of this file did exactly that; the DOM suite caught it before it shipped.
 *
 * The components hold no board state. Everything comes from the store's snapshot through
 * `useSyncExternalStore`, so there is one source of truth and a poll that changes nothing causes no
 * render. The only local state is interaction state: what is being dragged, what is typed in a box.
 *
 * Accessibility is not a garnish: a drag-only board cannot be used without a pointer, so every card
 * is focusable, `Alt+←/→` moves it, `Enter` opens it, and every state change is announced through
 * one `aria-live` region.
 */
import type { ReactElement } from 'react';
import type { BoardStore, BoardState } from './store.js';
import { selectedTask } from './store.js';
import { ageBand, ageDays, classLabel, columnsOf, formatAge, priorityBadge, type Column } from './model.js';
import { beginDrag, dragOver, dropTarget, indexFromPointer, keyboardTarget, type DragState } from './dnd.js';
import { STYLES } from './styles.js';
import { CHECK_LABEL, type CheckId, type State, type Task } from '../store/types.js';

/** The `require('react')` handle, passed down as a prop so this module stays realm-agnostic. */
export interface ReactLike {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => ReactElement;
  useState: <T>(initial: T) => [T, (next: T | ((previous: T) => T)) => void];
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  useRef: <T>(initial: T) => { current: T };
  useSyncExternalStore: <S>(subscribe: (listener: () => void) => () => void, getSnapshot: () => S) => S;
}

export interface BoardProps {
  readonly React: ReactLike;
  readonly store?: BoardStore;
  /** Read the page's visibility, so polling stops when the human is not looking. */
  readonly documentRef?: { readonly visibilityState?: string };
}

interface ChildProps {
  readonly React: ReactLike;
  readonly state: BoardState;
  readonly store: BoardStore;
  readonly onAnnounce: (message: string) => void;
}

// ------------------------------------------------------------------ chrome

function NoticeStrip(props: ChildProps): ReactElement | null {
  const { React, state, store } = props;
  if (state.notice === null) return null;
  const { notice } = state;
  return React.createElement(
    'div',
    { className: `kb-notice kb-notice-${notice.kind}`, role: 'status', 'aria-live': 'polite' },
    React.createElement('span', null, notice.message),
    notice.missing === undefined || notice.missing.length === 0
      ? null
      : React.createElement('span', { className: 'kb-notice-missing' }, `missing: ${notice.missing.join(', ')}`),
    React.createElement('button', { className: 'kb-btn', type: 'button', onClick: () => store.notice(null) }, 'Dismiss')
  );
}

function MetricsStrip(props: ChildProps): ReactElement | null {
  const { React, state } = props;
  const payload = state.payload;
  if (payload === null) return null;
  const metrics = payload.metrics;
  const num = (value: number | null): string => (value === null ? '—' : String(value));
  return React.createElement(
    'div',
    { className: 'kb-metrics' },
    React.createElement('span', null, React.createElement('b', null, 'WIP'), ` ${metrics.wip}`),
    React.createElement(
      'span',
      null,
      React.createElement('b', null, 'Throughput'),
      ` ${metrics.throughput.days7}/7d · ${metrics.throughput.days30}/30d`
    ),
    React.createElement(
      'span',
      null,
      React.createElement('b', null, 'Cycle'),
      ` median ${num(metrics.cycle.medianDays)}d · p85 ${num(metrics.cycle.p85Days)}d`
    ),
    React.createElement(
      'span',
      null,
      React.createElement('b', null, 'Age'),
      ` oldest ${num(metrics.ageing.oldestDays)}d · ${metrics.ageing.count} past SLE`
    ),
    React.createElement(
      'span',
      { className: 'kb-dim' },
      `SLE ${Math.round(metrics.sle.p * 100)}% ≤ ${metrics.sle.days}d (${metrics.sle.source})`
    )
  );
}

function SprintBar(props: ChildProps): ReactElement | null {
  const { React, state } = props;
  const active = state.payload?.sprints.find((sprint) => sprint.state === 'active');
  if (active === undefined) return null;
  const servedAt = state.payload?.servedAt ?? new Date().toISOString();
  const remaining = Math.max(0, Math.ceil((Date.parse(active.end) - Date.parse(servedAt)) / 86_400_000));
  return React.createElement(
    'div',
    { className: 'kb-bar' },
    React.createElement('span', { className: 'kb-chip kb-chip-kb' }, `${active.id} active`),
    React.createElement('span', null, active.goal.length === 0 ? '(no goal)' : active.goal),
    React.createElement('span', { className: 'kb-dim' }, `${remaining} day(s) left`)
  );
}

// ------------------------------------------------------------------ cards and lanes

interface CardProps extends ChildProps {
  readonly task: Task;
  readonly drag: DragState | null;
  readonly setDrag: (next: DragState | null) => void;
}

function CardView(props: CardProps): ReactElement {
  const { React, state, store, task, drag, setDrag, onAnnounce } = props;
  const days = ageDays(task, state.payload?.servedAt ?? new Date().toISOString());
  const band = ageBand(days, state.payload?.dow.sle.days ?? 3);
  const classes = ['kb-card'];
  if (task.classOfService === 'expedite') classes.push('kb-card-expedite');
  if (task.blockedReason !== null) classes.push('kb-card-blocked');

  const onKeyDown = (event: { key: string; altKey: boolean; preventDefault: () => void }): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void store.select(task.id);
      return;
    }
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const target = keyboardTarget(task.state, event.key === 'ArrowLeft' ? 'left' : 'right');
      if (target === null) {
        onAnnounce(`${task.id} is already at the edge of the board`);
        return;
      }
      onAnnounce(`${task.id} moved to ${target}`);
      void store.move(task.id, target);
    }
  };

  return React.createElement(
    'div',
    {
      className: classes.join(' '),
      draggable: true,
      tabIndex: 0,
      role: 'button',
      'aria-label': `${task.id} ${task.title}, ${task.state}, ${task.priority}`,
      'data-card': task.id,
      onDragStart: (event: { dataTransfer?: { setData: (type: string, value: string) => void; effectAllowed?: string } }) => {
        event.dataTransfer?.setData('text/plain', task.id);
        if (event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move';
        setDrag(beginDrag(task.id, task.state));
      },
      onDragEnd: () => setDrag(null),
      onKeyDown,
      onClick: () => {
        void store.select(task.id);
      },
    },
    React.createElement(
      'div',
      { className: 'kb-card-top' },
      React.createElement('span', { className: 'kb-card-id' }, task.id),
      React.createElement('span', { className: `kb-pri kb-pri-${task.priority.slice(0, 2)}` }, priorityBadge(task.priority)),
      React.createElement('span', { className: `kb-age kb-age-${band}` }, formatAge(days))
    ),
    React.createElement('div', { className: 'kb-card-title' }, task.title),
    React.createElement(
      'div',
      { className: 'kb-card-meta' },
      task.classOfService === 'standard' ? null : React.createElement('span', { className: 'kb-chip' }, classLabel(task)),
      task.blockedReason === null ? null : React.createElement('span', { className: 'kb-chip' }, 'blocked'),
      task.assignee === null ? null : React.createElement('span', { className: 'kb-chip' }, task.assignee),
      task.project === null ? null : React.createElement('span', { className: 'kb-chip' }, task.project),
      task.sprintId === null ? null : React.createElement('span', { className: 'kb-chip kb-chip-kb' }, task.sprintId)
    )
  );
}

interface LaneProps extends ChildProps {
  readonly column: Column;
  readonly drag: DragState | null;
  readonly setDrag: (next: DragState | null) => void;
}

function Lane(props: LaneProps): ReactElement {
  const { React, state, store, column, drag, setDrag, onAnnounce } = props;
  // A ref to the lane's card list, so a drop lands where the gap appeared rather than at the end.
  const cardsRef = React.useRef<{ children?: ArrayLike<{ getBoundingClientRect(): { top: number; height: number } }> } | null>(null);
  const isOver = drag?.overState === column.state;

  const indexAt = (clientY: number): number => {
    const container = cardsRef.current;
    if (container?.children === undefined) return column.cards.length;
    const midpoints = Array.from(container.children).map((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    return indexFromPointer(column.cards, drag?.taskId ?? '', clientY, midpoints);
  };

  const classes = ['kb-lane'];
  if (isOver) classes.push('kb-lane-over');
  if (column.over) classes.push('kb-lane-over-limit');

  return React.createElement(
    'div',
    {
      className: classes.join(' '),
      'data-lane': column.state,
      'aria-label': `${column.label}, ${column.cards.length} card(s)`,
      onDragOver: (event: { preventDefault: () => void; clientY: number }) => {
        event.preventDefault();
        if (drag === null) return;
        setDrag(dragOver(drag, column.state, indexAt(event.clientY)));
      },
      onDrop: (event: { preventDefault: () => void }) => {
        event.preventDefault();
        const target = dropTarget(drag);
        setDrag(null);
        if (target === null) return;
        void store.move(target.taskId, target.toState, target.index);
      },
    },
    React.createElement(
      'div',
      { className: 'kb-lane-head' },
      React.createElement('span', { className: 'kb-lane-name' }, column.label),
      React.createElement(
        'span',
        { className: 'kb-lane-count' },
        column.limit === undefined ? String(column.cards.length) : `${column.cards.length}/${column.limit}`
      ),
      column.over ? React.createElement('span', { className: 'kb-chip' }, 'over limit') : null
    ),
    React.createElement(
      'div',
      { className: 'kb-cards', ref: cardsRef },
      column.cards.length === 0
        ? React.createElement('div', { className: 'kb-empty' }, 'nothing here')
        : column.cards.map((task) =>
            React.createElement(CardView, {
              key: task.id,
              React,
              state,
              store,
              onAnnounce,
              task,
              drag,
              setDrag,
            })
          )
    )
  );
}

// ------------------------------------------------------------------ the drawer

interface ChecksProps extends ChildProps {
  readonly task: Task;
  readonly gate: 'dor' | 'dod';
  readonly items: readonly CheckId[];
}

function ChecklistRows(props: ChecksProps): ReactElement {
  const { React, store, task, gate, items } = props;
  const checked: Record<string, unknown> = gate === 'dor' ? { ...task.dor } : { ...task.dod };
  return React.createElement(
    'div',
    { className: 'kb-checks', 'aria-label': gate === 'dor' ? 'Definition of Ready' : 'Definition of Done' },
    React.createElement('span', { className: 'kb-dim' }, gate === 'dor' ? 'Definition of Ready' : 'Definition of Done'),
    items.map((id) =>
      React.createElement(
        'button',
        {
          key: id,
          type: 'button',
          className: `kb-check kb-btn${checked[id] === undefined ? ' kb-check-missing' : ''}`,
          'aria-pressed': checked[id] !== undefined,
          onClick: () => {
            void store.tick(task.id, gate, id, checked[id] === undefined);
          },
        },
        `${checked[id] === undefined ? '☐' : '☑'} ${CHECK_LABEL[id]}`
      )
    )
  );
}

interface DrawerProps extends ChildProps {
  readonly task: Task;
}

function Drawer(props: DrawerProps): ReactElement {
  const { React, state, store, task, onAnnounce } = props;
  const [comment, setComment] = React.useState('');
  const [dropReason, setDropReason] = React.useState('');
  const detail = state.detail;
  const events = detail?.events ?? [];
  const comments = detail?.comments ?? [];
  const days = ageDays(task, state.payload?.servedAt ?? new Date().toISOString());

  return React.createElement(
    'div',
    { className: 'kb-drawer', 'data-drawer': task.id },
    React.createElement(
      'div',
      { className: 'kb-drawer-head' },
      React.createElement('span', { className: 'kb-card-id' }, task.id),
      React.createElement('span', { className: 'kb-lane-name' }, task.title),
      React.createElement('span', { className: 'kb-spacer' }),
      React.createElement('span', { className: 'kb-chip' }, task.state),
      React.createElement('span', { className: 'kb-chip' }, task.priority),
      React.createElement('span', { className: 'kb-chip' }, classLabel(task)),
      React.createElement('span', { className: 'kb-chip' }, `age ${formatAge(days)}`),
      React.createElement('button', { className: 'kb-btn', type: 'button', onClick: () => void store.select(null) }, 'Close')
    ),
    task.blockedReason === null
      ? null
      : React.createElement('div', { className: 'kb-notice kb-notice-refusal' }, `Blocked: ${task.blockedReason}`),
    React.createElement(
      'div',
      { className: 'kb-bar' },
      ...(['backlog', 'ready', 'in-progress', 'review', 'done'] as State[])
        .filter((target) => target !== task.state)
        .map((target) =>
          React.createElement(
            'button',
            {
              key: target,
              className: 'kb-btn',
              type: 'button',
              onClick: () => {
                onAnnounce(`${task.id} moved to ${target}`);
                void store.move(task.id, target);
              },
            },
            `→ ${target}`
          )
        ),
      task.blockedReason === null
        ? React.createElement(
            'button',
            { className: 'kb-btn', type: 'button', onClick: () => void store.block(task.id, 'blocked from the panel') },
            'Block'
          )
        : React.createElement('button', { className: 'kb-btn', type: 'button', onClick: () => void store.unblock(task.id) }, 'Unblock'),
      // Dropping needs a written reason, so it is an input and not a dialog: `prompt()` is
      // unavailable in the desktop renderer and untestable under jsdom, and the reason is evidence
      // the board keeps forever. The button stays disabled until there is one.
      React.createElement('input', {
        className: 'kb-input',
        type: 'text',
        placeholder: 'reason to drop…',
        'aria-label': 'Reason to drop',
        value: dropReason,
        onChange: (event: { target: { value: string } }) => setDropReason(event.target.value),
      }),
      React.createElement(
        'button',
        {
          className: 'kb-btn',
          type: 'button',
          disabled: dropReason.trim().length === 0,
          onClick: () => {
            void store.drop(task.id, dropReason.trim());
            setDropReason('');
          },
        },
        'Drop'
      )
    ),
    React.createElement(ChecklistRows, { React, state, store, onAnnounce, task, gate: 'dor', items: state.payload?.dow.dor ?? [] }),
    React.createElement(ChecklistRows, { React, state, store, onAnnounce, task, gate: 'dod', items: state.payload?.dow.dod ?? [] }),
    React.createElement(
      'div',
      { className: 'kb-list' },
      React.createElement('span', { className: 'kb-dim' }, `outcome: ${task.outcome ?? '—'}`),
      React.createElement('span', { className: 'kb-dim' }, `acceptance: ${task.acceptance ?? '—'}`),
      React.createElement(
        'span',
        { className: 'kb-dim' },
        `owner ${task.assignee ?? '—'} · project ${task.project ?? '—'} · sprint ${task.sprintId ?? '—'}`
      ),
      React.createElement(
        'span',
        { className: 'kb-dim' },
        `rev ${task.rev} · started ${task.startedAt ?? '—'} · finished ${task.finishedAt ?? '—'}`
      )
    ),
    React.createElement(
      'div',
      { className: 'kb-bar' },
      React.createElement('input', {
        className: 'kb-input',
        type: 'text',
        placeholder: 'comment…',
        'aria-label': 'Comment',
        value: comment,
        onChange: (event: { target: { value: string } }) => setComment(event.target.value),
      }),
      React.createElement(
        'button',
        {
          className: 'kb-btn',
          type: 'button',
          disabled: comment.trim().length === 0,
          onClick: () => {
            void store.comment(task.id, comment);
            setComment('');
          },
        },
        'Comment'
      )
    ),
    comments.length === 0
      ? null
      : React.createElement(
          'div',
          { className: 'kb-list' },
          comments.map((entry) =>
            React.createElement('span', { className: 'kb-dim', key: String(entry.id) }, `${entry.actor}: ${entry.body}`)
          )
        ),
    events.length === 0
      ? null
      : React.createElement(
          'div',
          { className: 'kb-list' },
          React.createElement('span', { className: 'kb-dim' }, 'history'),
          events.map((entry) =>
            React.createElement(
              'span',
              { className: 'kb-mono kb-dim', key: String(entry.id) },
              `${entry.at.slice(0, 16)} ${entry.kind}${entry.toState === null ? '' : ` → ${entry.toState}`} (${entry.actor})`
            )
          )
        )
  );
}

// ------------------------------------------------------------------ the panel

/**
 * The whole panel.
 *
 * One `aria-live` region carries every announcement and it is rendered once: several live regions
 * make a screen reader race itself.
 */
export function BoardPage(props: BoardProps): ReactElement {
  const { React, store } = props;
  if (store === undefined) throw new Error('the kanban panel was mounted without its store');
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const [draft, setDraft] = React.useState('');

  React.useEffect(() => store.start(), [store]);

  const columns = state.payload === null ? [] : columnsOf(state.payload, state.filter);
  const task = selectedTask(state);
  const onAnnounce = (message: string): void => setAnnouncement(message);
  const child = { React, state, store, onAnnounce };

  return React.createElement(
    'div',
    { className: 'kb-page' },
    React.createElement('style', null, STYLES),
    React.createElement(
      'div',
      { className: 'kb-head' },
      React.createElement('h1', { className: 'kb-title' }, state.payload?.title ?? 'Kanban'),
      React.createElement(
        'span',
        { className: 'kb-sub' },
        state.payload === null ? 'connecting…' : `rev ${state.payload.rev} · ${state.payload.total} cards`
      ),
      React.createElement('span', { className: 'kb-spacer' }),
      React.createElement('span', { className: 'kb-sub' }, `host ${state.origin.origin} · ${state.origin.source}`),
      React.createElement('button', { className: 'kb-btn', type: 'button', onClick: () => void store.refresh(true) }, 'Refresh')
    ),
    React.createElement(
      'div',
      { className: 'kb-bar' },
      React.createElement('input', {
        className: 'kb-input',
        type: 'search',
        placeholder: 'search cards…',
        'aria-label': 'Search cards',
        value: state.filter.search ?? '',
        onChange: (event: { target: { value: string } }) =>
          store.setFilter({ ...state.filter, search: event.target.value.length === 0 ? undefined : event.target.value }),
      }),
      ...(state.payload?.views ?? []).map((view) =>
        React.createElement(
          'button',
          { key: view.id, className: 'kb-btn', type: 'button', title: view.description, onClick: () => store.setFilter(view.filter) },
          view.name
        )
      ),
      React.createElement('button', { className: 'kb-btn', type: 'button', onClick: () => store.setFilter({}) }, 'All'),
      React.createElement('span', { className: 'kb-spacer' }),
      React.createElement('input', {
        className: 'kb-input',
        type: 'text',
        placeholder: 'new card…',
        'aria-label': 'New card title',
        value: draft,
        onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
      }),
      React.createElement(
        'button',
        {
          className: 'kb-btn',
          type: 'button',
          disabled: draft.trim().length === 0,
          onClick: () => {
            const title = draft;
            setDraft('');
            void store.create(title);
          },
        },
        'Add'
      )
    ),
    React.createElement(NoticeStrip, child),
    // A partly-read board says so on screen, for the same reason the generated file does: the
    // metrics are computed from the cards that were read.
    state.payload?.truncated == null
      ? null
      : React.createElement(
          'div',
          { className: 'kb-notice kb-notice-info' },
          `showing ${state.payload.truncated.shown} of ${state.payload.truncated.total} cards — the flow metrics cover only those`
        ),
    React.createElement(MetricsStrip, child),
    React.createElement('div', { className: 'kb-dim', role: 'status', 'aria-live': 'polite' }, announcement),
    state.status === 'error' && state.payload === null
      ? React.createElement(
          'div',
          { className: 'kb-notice kb-notice-error' },
          `board unavailable: ${state.lastError ?? 'unknown'} — the host route did not answer`
        )
      : React.createElement(
          'div',
          { className: 'kb-lanes' },
          columns.map((column) => React.createElement(Lane, { key: column.state, ...child, column, drag, setDrag }))
        ),
    React.createElement(SprintBar, child),
    task === undefined ? null : React.createElement(Drawer, { ...child, task })
  );
}

/** The sidebar icon, built with its own React handle. Receives `{ size, active }` from the row. */
export function createKanbanIcon(React: ReactLike): (props: { size?: number; active?: boolean }) => ReactElement {
  return function KanbanIcon(props: { size?: number; active?: boolean }): ReactElement {
    const size = typeof props.size === 'number' ? props.size : 20;
    return React.createElement(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props.active === true ? 1.8 : 1.4,
        'aria-hidden': 'true',
      },
      React.createElement('rect', { x: 2.5, y: 3, width: 4.4, height: 14, rx: 1.2 }),
      React.createElement('rect', { x: 8.1, y: 3, width: 4.4, height: 10, rx: 1.2 }),
      React.createElement('rect', { x: 13.7, y: 3, width: 4.4, height: 7, rx: 1.2 })
    );
  };
}
