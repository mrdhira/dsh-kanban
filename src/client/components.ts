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
import { EMPTY_FILTER, ageBand, ageDays, classLabel, columnsOf, filterableStates, formatAge, formatPercent, formatStamp, hasFilter, moveTargets, priorityCode, priorityText, priorityWord, sameFilter, type Column } from './model.js';
import { beginDrag, dragOver, dropTarget, indexFromPointer, keyboardTarget, type DragState } from './dnd.js';
import { API_PREFIX } from './api.js';
import { STYLES, STYLE_ID } from './styles.js';
import { CHECK_LABEL, CLASSES_OF_SERVICE, CLASS_LABEL, PRIORITIES, PRIORITY_LABEL, STATE_LABEL, type CheckId, type ClassOfService, type Priority, type State, type Task } from '../store/types.js';

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
  readonly documentRef?: {
    readonly visibilityState?: string;
    readonly head?: { append(node: unknown): unknown };
    getElementById(id: string): { remove(): void } | null;
  };
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
  // The two numbers that call for action lead: how full the WIP control is, and how the oldest card
  // reads against the SLE. Everything else is history and is demoted, so the strip has one scan
  // order instead of nine equal items.
  const wipLimit = payload.dow.wip['in-progress'] + payload.dow.wip.review;
  const lead = (label: string, value: string): ReactElement =>
    React.createElement('span', { className: 'kb-metric-lead' }, React.createElement('b', null, label), ` ${value}`);
  const rest = (label: string, value: string): ReactElement =>
    React.createElement('span', { className: 'kb-dim' }, React.createElement('b', null, label), ` ${value}`);
  return React.createElement(
    'div',
    { className: 'kb-metrics', 'aria-label': 'Flow metrics' },
    lead('WIP', `${metrics.wip}/${wipLimit}`),
    lead('Oldest', `${num(metrics.ageing.oldestDays)}d / ${metrics.sle.days}d SLE · ${metrics.ageing.count} past`),
    rest('Cycle', `median ${num(metrics.cycle.medianDays)}d`),
    rest('Throughput', `${metrics.throughput.days7}/7d · ${metrics.throughput.days30}/30d`),
    // `p85` is deliberately absent: nine items in one 12px row is a wall, and the 85th percentile
    // of a board this size is noise beside the median. The full metrics stay in `kanban_metrics`.
    rest('SLE', `${formatPercent(metrics.sle.p)}% ≤ ${metrics.sle.days}d (${metrics.sle.source})`)
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

/** The focusable node of every mounted card, keyed by task id — how a closing drawer finds its card. */
type CardNode = { focus(): void };
type CardNodes = { current: Map<string, CardNode> };

/**
 * The two checklist states, drawn rather than typed.
 *
 * Unicode `☐`/`☑` standing in for an icon system is the craft floor's refusal: the glyph's weight
 * and metrics belong to whatever font the host happens to load. One stroke width, `currentColor`,
 * and `aria-hidden` — `aria-pressed` on the button stays the only source of truth.
 */
function checkGlyph(React: ReactLike, checked: boolean, className: string): ReactElement {
  return React.createElement(
    'svg',
    {
      className,
      width: 14,
      height: 14,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    React.createElement('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2.5 }),
    checked ? React.createElement('path', { d: 'M5 8.2 7.4 10.6 11 5.6' }) : null
  );
}

interface CardProps extends ChildProps {
  readonly task: Task;
  readonly drag: DragState | null;
  readonly setDrag: (next: DragState | null) => void;
  readonly cardNodes: CardNodes;
}

function CardView(props: CardProps): ReactElement {
  const { React, state, store, task, drag, setDrag, onAnnounce, cardNodes } = props;
  const days = ageDays(task, state.payload?.servedAt ?? new Date().toISOString());
  const band = ageBand(days, state.payload?.dow.sle.days ?? 3);
  const classes = ['kb-card'];
  if (task.classOfService === 'expedite') classes.push('kb-card-expedite');
  if (task.blockedReason !== null) classes.push('kb-card-blocked');
  if (task.state === 'done') classes.push('kb-card-done');
  // The top row holds the id, the priority code and the age inside a 236px lane, so it keeps the
  // numbers and the words move down to the chip row, which wraps without breaking a token. The words
  // are what keep the meaning alive without colour (amber cannot carry small text on white: 2.15:1
  // measured), so they are relocated, never dropped.
  const age = formatAge(days);
  const priorityLabel = priorityWord(task.priority);
  const ageLabel = band === 'fresh' ? null : band;

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
      // Labels, not slugs: `in-progress` is the store's spelling, not a human's (see B4).
      'aria-label': `${task.id} ${task.title}, ${STATE_LABEL[task.state]}, ${PRIORITY_LABEL[task.priority]}`,
      'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
      'data-card': task.id,
      ref: (node: CardNode) => {
        // Remember the live node for as long as it is mounted, so the drawer can hand focus back
        // to the card it was opened from — including after a poll has replaced the lane's children.
        if (node === null) cardNodes.current.delete(task.id);
        else cardNodes.current.set(task.id, node);
      },
      onDragStart: (event: { dataTransfer?: { setData: (type: string, value: string) => void; effectAllowed?: string } }) => {
        event.dataTransfer?.setData('text/plain', task.id);
        if (event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move';
        setDrag(beginDrag(task.id, task.state));
      },
      onDragEnd: () => setDrag(null),
      onKeyDown,
      onClick: (event: { currentTarget?: { focus?: () => void } }) => {
        // Keep the keyboard's place when the pointer opens a card: the drawer returns focus here.
        event.currentTarget?.focus?.();
        void store.select(task.id);
      },
    },
    React.createElement(
      'div',
      { className: 'kb-card-top' },
      // A finished card is otherwise indistinguishable from one in review: same shape, same
      // hairline. A drawn, success-toned mark — never a thick coloured edge.
      task.state === 'done' ? checkGlyph(React, true, 'kb-mark') : null,
      React.createElement('span', { className: 'kb-card-id' }, task.id),
      React.createElement('span', { className: `kb-pri kb-pri-${task.priority.slice(0, 2)}` }, priorityCode(task.priority)),
      React.createElement('span', { className: `kb-age kb-age-${band}` }, age)
    ),
    React.createElement('div', { className: 'kb-card-title' }, task.title),
    React.createElement(
      'div',
      { className: 'kb-card-meta' },
      priorityLabel === null ? null : React.createElement('span', { className: 'kb-chip' }, priorityLabel),
      ageLabel === null ? null : React.createElement('span', { className: 'kb-chip' }, ageLabel),
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
  readonly cardNodes: CardNodes;
}

function Lane(props: LaneProps): ReactElement {
  const { React, state, store, column, drag, setDrag, onAnnounce, cardNodes } = props;
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
  // A lane with nothing in it is a rail, not a column: four empty lanes holding 236px each is what
  // forces the sideways scroll to scroll for nothing. It opens up again the moment a drag starts,
  // because a drop target you cannot hit is not a drop target.
  if (column.cards.length === 0) classes.push('kb-lane-empty');
  if (column.cards.length === 0 && drag !== null) classes.push('kb-lane-awake');

  return React.createElement(
    'div',
    {
      className: classes.join(' '),
      'data-lane': column.state,
      'aria-label': `${column.label}, ${column.cards.length} card(s)`,
      'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
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
              cardNodes,
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
    items.map((id) => {
      const missing = checked[id] === undefined;
      return React.createElement(
        'button',
        {
          key: id,
          type: 'button',
          className: `kb-check kb-btn${missing ? ' kb-check-missing' : ''}`,
          'aria-pressed': !missing,
          onClick: () => {
            void store.tick(task.id, gate, id, missing);
          },
        },
        checkGlyph(React, !missing, 'kb-check-glyph'),
        // `· unticked` carries the amber's meaning as text, for the same AA reason as the card badge.
        React.createElement('span', null, `${CHECK_LABEL[id]}${missing ? ' · unticked' : ''}`)
      );
    })
  );
}

interface DrawerProps extends ChildProps {
  readonly task: Task;
  readonly cardNodes: CardNodes;
}

function Drawer(props: DrawerProps): ReactElement {
  const { React, state, store, task, onAnnounce, cardNodes } = props;
  const [comment, setComment] = React.useState('');
  const [dropReason, setDropReason] = React.useState('');
  const [blockReason, setBlockReason] = React.useState('');
  const [position, setPosition] = React.useState(String(task.position));
  const [exceptionOpen, setExceptionOpen] = React.useState(false);
  const [exceptionReason, setExceptionReason] = React.useState('');
  const [exceptionTarget, setExceptionTarget] = React.useState<State>(moveTargets(task.state)[0] ?? task.state);
  const drawerRef = React.useRef<HTMLDivElement | null>(null);
  const detail = state.detail;
  const events = detail?.events ?? [];
  const comments = detail?.comments ?? [];
  const days = ageDays(task, state.payload?.servedAt ?? new Date().toISOString());

  /**
   * Focus the drawer when it opens, hand it back when it closes.
   *
   * The drawer is not a modal and it traps nothing: `Tab` leaves it like any other box, and Escape
   * is a convenience beside the Close button rather than the only way out. But a pane that appears
   * below the card the human just activated must move the keyboard's place with it, or the next
   * `Tab` walks the whole toolbar before reaching it.
   */
  React.useEffect(() => {
    const node = drawerRef.current;
    const active = document.activeElement;
    const previouslyFocused: CardNode | null =
      cardNodes.current.get(task.id) ?? (active instanceof HTMLElement && active !== node ? active : null);
    node?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  // The card's position can move under the drawer (a drop, or another operator's poll). The field
  // follows it rather than holding a number the human would be editing blind.
  React.useEffect(() => {
    setPosition(String(task.position));
  }, [task.position]);

  const onKeyDown = (event: { key: string; preventDefault: () => void }): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    void store.select(null);
  };

  // `dropped` is reached through Drop and its reason, not through this menu, so it is not offered.
  const moveButtons = (['backlog', 'ready', 'in-progress', 'review', 'done'] as State[]).filter(
    (target) => target !== task.state
  );
  const exceptionTargets: readonly State[] = moveTargets(task.state).filter((target) => target !== 'dropped');
  const exceptionTo = exceptionTargets.includes(exceptionTarget)
    ? exceptionTarget
    : (exceptionTargets[0] ?? task.state);
  const positionValue = Number(position);
  const positionReady =
    position.trim().length > 0 && Number.isFinite(positionValue) && positionValue !== task.position;

  return React.createElement(
    'div',
    { className: 'kb-drawer', 'data-drawer': task.id, tabIndex: -1, ref: drawerRef, onKeyDown },
    React.createElement(
      'div',
      { className: 'kb-drawer-head' },
      React.createElement('span', { className: 'kb-card-id' }, task.id),
      React.createElement('span', { className: 'kb-lane-name' }, task.title),
      React.createElement('span', { className: 'kb-spacer' }),
      // One spelling for one entity: the store's `in-progress` is not a human's "In Progress".
      React.createElement('span', { className: 'kb-chip' }, STATE_LABEL[task.state]),
      React.createElement('span', { className: 'kb-chip' }, PRIORITY_LABEL[task.priority]),
      React.createElement('span', { className: 'kb-chip' }, classLabel(task)),
      React.createElement('span', { className: 'kb-chip' }, `age ${formatAge(days)}`),
      // The keyboard path a card has always had, said where a human opens a card to look.
      React.createElement('span', { className: 'kb-dim' }, 'Alt+←/→ moves · Esc closes'),
      React.createElement(
        'button',
        { className: 'kb-btn', type: 'button', onClick: () => void store.select(null) },
        'Close'
      )
    ),
    task.blockedReason === null
      ? null
      : React.createElement('div', { className: 'kb-notice kb-notice-refusal' }, `Blocked: ${task.blockedReason}`),
    // Priority and class of service are the human's to set (PRODUCT.md), and `kanban_update` can do
    // it; the panel sends its own actor and renders whatever refusal comes back.
    React.createElement(
      'div',
      { className: 'kb-group' },
      React.createElement('span', { className: 'kb-dim' }, 'detail'),
      React.createElement(
        'div',
        { className: 'kb-bar' },
        React.createElement('span', { className: 'kb-dim' }, 'priority'),
        React.createElement(
          'select',
          {
            className: 'kb-input',
            'data-select': 'priority',
            'aria-label': `${task.id} priority`,
            value: task.priority,
            onChange: (event: { target: { value: string } }) => {
              void store.patch(task.id, { priority: event.target.value as Priority });
            },
          },
          ...PRIORITIES.map((entry) => React.createElement('option', { key: entry, value: entry }, PRIORITY_LABEL[entry]))
        ),
        React.createElement('span', { className: 'kb-dim' }, 'class'),
        React.createElement(
          'select',
          {
            className: 'kb-input',
            'data-select': 'class',
            'aria-label': `${task.id} class of service`,
            value: task.classOfService,
            onChange: (event: { target: { value: string } }) => {
              void store.patch(task.id, { classOfService: event.target.value as ClassOfService });
            },
          },
          ...CLASSES_OF_SERVICE.map((entry) =>
            React.createElement('option', { key: entry, value: entry }, CLASS_LABEL[entry])
          )
        )
      )
    ),
    React.createElement(
      'div',
      { className: 'kb-group' },
      React.createElement('span', { className: 'kb-dim' }, 'move'),
      React.createElement(
        'div',
        { className: 'kb-bar' },
        ...moveButtons.map((target) =>
          React.createElement(
            'button',
            {
              key: target,
              className: 'kb-btn',
              type: 'button',
              // `→ ready` is unreadable out of context; the label says which card and where.
              'aria-label': `Move ${task.id} to ${STATE_LABEL[target]}`,
              onClick: () => {
                // The board's one live region carries the intent; a refusal follows through the
                // notice strip, so this is never the last word on a move the host rejected.
                onAnnounce(`moving ${task.id} to ${STATE_LABEL[target]}`);
                void store.move(task.id, target);
              },
            },
            `→ ${STATE_LABEL[target]}`
          )
        ),
        // Reordering is not pointer-only: a position is a number, and `kanban_move.toPosition` is
        // the same number.
        React.createElement('span', { className: 'kb-dim' }, 'position'),
        React.createElement('input', {
          className: 'kb-input',
          type: 'number',
          step: 1,
          'data-field': 'position',
          'aria-label': `Position of ${task.id} in ${STATE_LABEL[task.state]}`,
          value: position,
          onChange: (event: { target: { value: string } }) => setPosition(event.target.value),
        }),
        React.createElement(
          'button',
          {
            className: 'kb-btn',
            type: 'button',
            'data-action': 'set-position',
            disabled: !positionReady,
            onClick: () => {
              onAnnounce(`${task.id} moved to position ${String(positionValue)}`);
              void store.move(task.id, task.state, undefined, { position: positionValue });
            },
          },
          'Set position'
        ),
        React.createElement(
          'button',
          {
            className: 'kb-btn',
            type: 'button',
            'data-action': 'exception',
            'aria-expanded': exceptionOpen,
            onClick: () => setExceptionOpen(!exceptionOpen),
          },
          'Exception…'
        )
      ),
      // The exception is the one path an agent has and a drag does not, so it is explicit, needs a
      // written reason, and still goes through `checkMoveLocally` and then the host.
      exceptionOpen
        ? React.createElement(
            'div',
            { className: 'kb-bar' },
            React.createElement('span', { className: 'kb-dim' }, 'except'),
            React.createElement(
              'select',
              {
                className: 'kb-input',
                'data-select': 'exception-target',
                'aria-label': `Exception target for ${task.id}`,
                value: exceptionTo,
                onChange: (event: { target: { value: string } }) => setExceptionTarget(event.target.value as State),
              },
              ...exceptionTargets.map((target) =>
                React.createElement('option', { key: target, value: target }, STATE_LABEL[target])
              )
            ),
            React.createElement('input', {
              className: 'kb-input',
              type: 'text',
              'data-field': 'exception-reason',
              placeholder: 'reason to except…',
              'aria-label': 'Reason for the exception',
              value: exceptionReason,
              onChange: (event: { target: { value: string } }) => setExceptionReason(event.target.value),
            }),
            React.createElement(
              'button',
              {
                className: 'kb-btn',
                type: 'button',
                'data-action': 'except',
                disabled: exceptionReason.trim().length === 0,
                onClick: () => {
                  onAnnounce(`excepting the gate for ${task.id}`);
                  // Deliberately not cleared: if the host refuses, the human must still see the
                  // reason they wrote rather than an empty box beside the refusal.
                  void store.move(task.id, exceptionTo, undefined, { force: true, reason: exceptionReason.trim() });
                },
              },
              'Move with exception'
            )
          )
        : null
    ),
    React.createElement(
      'div',
      { className: 'kb-group' },
      React.createElement('span', { className: 'kb-dim' }, 'block'),
      task.blockedReason === null
        ? React.createElement(
            'div',
            { className: 'kb-bar' },
            // A blocker is evidence: the host refuses an empty one, so the button waits for it.
            React.createElement('input', {
              className: 'kb-input',
              type: 'text',
              'data-field': 'block-reason',
              placeholder: 'reason to block…',
              'aria-label': 'Reason to block',
              value: blockReason,
              onChange: (event: { target: { value: string } }) => setBlockReason(event.target.value),
            }),
            React.createElement(
              'button',
              {
                className: 'kb-btn',
                type: 'button',
                'data-action': 'block',
                disabled: blockReason.trim().length === 0,
                onClick: () => {
                  void store.block(task.id, blockReason.trim());
                  setBlockReason('');
                },
              },
              'Block'
            )
          )
        : React.createElement(
            'div',
            { className: 'kb-bar' },
            React.createElement(
              'button',
              { className: 'kb-btn', type: 'button', 'data-action': 'unblock', onClick: () => void store.unblock(task.id) },
              'Unblock'
            )
          )
    ),
    // The destructive zone, kept apart from the reversible moves above it.
    React.createElement(
      'div',
      { className: 'kb-group kb-group-danger' },
      React.createElement('span', { className: 'kb-dim' }, 'drop'),
      React.createElement(
        'div',
        { className: 'kb-bar' },
        // Dropping needs a written reason, so it is an input and not a dialog: `prompt()` is
        // unavailable in the desktop renderer and untestable under jsdom, and the reason is evidence
        // the board keeps forever. The button stays disabled until there is one.
        React.createElement('input', {
          className: 'kb-input',
          type: 'text',
          'data-field': 'drop-reason',
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
            'data-action': 'drop',
            disabled: dropReason.trim().length === 0,
            onClick: () => {
              void store.drop(task.id, dropReason.trim());
              setDropReason('');
            },
          },
          'Drop'
        )
      )
    ),
    React.createElement(ChecklistRows, { React, state, store, onAnnounce, task, gate: 'dor', items: state.payload?.dow.dor ?? [] }),
    React.createElement(ChecklistRows, { React, state, store, onAnnounce, task, gate: 'dod', items: state.payload?.dow.dod ?? [] }),
    React.createElement(
      'div',
      { className: 'kb-list' },
      React.createElement('span', { className: 'kb-dim kb-prose' }, `outcome: ${task.outcome ?? '—'}`),
      React.createElement('span', { className: 'kb-dim kb-prose' }, `acceptance: ${task.acceptance ?? '—'}`),
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
              `${formatStamp(entry.at)} ${entry.kind}${entry.toState === null ? '' : ` → ${STATE_LABEL[entry.toState]}`} (${entry.actor})`
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
  const { React, store, documentRef } = props;
  if (store === undefined) throw new Error('the kanban panel was mounted without its store');
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const [draft, setDraft] = React.useState('');
  /** The two fields a new card carries beyond its title, so a human card can start refined. */
  const [draftPriority, setDraftPriority] = React.useState<Priority>('p2-normal');
  const [draftClass, setDraftClass] = React.useState<ClassOfService>('standard');
  /** Live card nodes, so a closing drawer can return focus to the card it was opened from. */
  const cardNodes = React.useRef<Map<string, CardNode>>(new Map());

  React.useEffect(() => store.start(), [store]);

  /**
   * Inject the stylesheet once, under `STYLE_ID`.
   *
   * A `<style>` element inside the render tree is written on every render — and the board re-renders
   * on every poll, so the old version handed the browser a fresh 4 KB sheet several times a minute.
   * The sheet is document-wide state, so it lives in the document head, guarded by its id.
   */
  React.useEffect(() => {
    const head = documentRef?.head;
    if (head === undefined || documentRef === undefined) return;
    if (documentRef.getElementById(STYLE_ID) !== null) return;
    const node = document.createElement('style');
    node.id = STYLE_ID;
    node.textContent = STYLES;
    head.append(node);
    // The panel may be unmounted while the app keeps running; the sheet is ours, so it goes too.
    return () => {
      documentRef.getElementById(STYLE_ID)?.remove();
    };
  }, [documentRef]);

  const columns = state.payload === null ? [] : columnsOf(state.payload, state.filter);
  const shown = columns.reduce((total, column) => total + column.cards.length, 0);
  const total = state.payload?.total ?? 0;
  const filtered = hasFilter(state.filter);
  const task = selectedTask(state);
  const onAnnounce = (message: string): void => setAnnouncement(message);
  const child = { React, state, store, onAnnounce, cardNodes };
  /**
   * Add or remove one lane from the state filter.
   *
   * The filter is the source of truth for what is selected — **not** the lanes on screen, which a
   * search or a saved view has already narrowed. Seeding from the visible lanes made the first chip
   * press keep every occupied lane and drop only the one clicked, which is the inverse of a toggle.
   */
  const toggleState = (target: State): void => {
    const active = state.filter.state ?? [];
    const next = active.includes(target) ? active.filter((entry) => entry !== target) : [...active, target];
    // A fresh object either way: handing the shared `EMPTY_FILTER` constant to the store would let a
    // later `{ ...filter, state }` carry the previous selection back in.
    store.setFilter(next.length === 0 ? {} : { ...state.filter, state: next });
  };

  return React.createElement(
    'div',
    { className: 'kb-page' },
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
      React.createElement(
        'nav',
        { 'aria-label': 'Views', className: 'kb-bar' },
        ...(state.payload?.views ?? []).map((view) =>
          React.createElement(
            'button',
            {
              key: view.id,
              className: 'kb-btn',
              type: 'button',
              title: view.description,
              'aria-pressed': sameFilter(state.filter, view.filter),
              onClick: () => store.setFilter(view.filter),
            },
            view.name
          )
        ),
        React.createElement(
          'button',
          { className: 'kb-btn', type: 'button', 'aria-pressed': !filtered, onClick: () => store.setFilter(EMPTY_FILTER) },
          'All'
        )
      ),
      React.createElement('span', { className: 'kb-spacer' }),
      React.createElement('input', {
        className: 'kb-input',
        type: 'text',
        placeholder: 'new card…',
        'aria-label': 'New card title',
        value: draft,
        onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
      }),
      // The values go in the create call, not a follow-up patch: `kanban_create` takes both, and a
      // card with no id yet cannot be patched. An agent may pass them too — the host's rule on who
      // may set a priority is the host's, and this panel does not pre-empt it.
      React.createElement(
        'select',
        {
          className: 'kb-input',
          'data-select': 'new-priority',
          'aria-label': 'New card priority',
          value: draftPriority,
          onChange: (event: { target: { value: string } }) => setDraftPriority(event.target.value as Priority),
        },
        ...PRIORITIES.map((entry) => React.createElement('option', { key: entry, value: entry }, PRIORITY_LABEL[entry]))
      ),
      React.createElement(
        'select',
        {
          className: 'kb-input',
          'data-select': 'new-class',
          'aria-label': 'New card class of service',
          value: draftClass,
          onChange: (event: { target: { value: string } }) => setDraftClass(event.target.value as ClassOfService),
        },
        ...CLASSES_OF_SERVICE.map((entry) =>
          React.createElement('option', { key: entry, value: entry }, CLASS_LABEL[entry])
        )
      ),
      React.createElement(
        'button',
        {
          className: 'kb-btn',
          type: 'button',
          'data-action': 'create',
          disabled: draft.trim().length === 0,
          onClick: () => {
            const title = draft;
            setDraft('');
            setDraftPriority('p2-normal');
            setDraftClass('standard');
            void store.create(title, { priority: draftPriority, classOfService: draftClass });
          },
        },
        'Add'
      )
    ),
    React.createElement(
      'div',
      { className: 'kb-bar' },
      React.createElement(
        'span',
        { className: 'kb-dim' },
        filtered ? `showing ${shown} of ${total} cards` : `${total} cards`
      ),
      filtered ? React.createElement('span', { className: 'kb-spacer' }) : null,
      filtered ? React.createElement('span', { className: 'kb-dim' }, 'state') : null,
      ...filterableStates().map((entry) =>
        React.createElement(
          'button',
          {
            key: entry,
            className: 'kb-btn',
            type: 'button',
            'data-state': entry,
            'aria-pressed': (state.filter.state ?? []).includes(entry),
            onClick: () => toggleState(entry),
          },
          STATE_LABEL[entry]
        )
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
          // Name everything a reader needs to tell "the route is down" from "the browser blocked it":
          // the URL attempted, the origin it came from, and what the *document* says it is. The first
          // live failure said only "Failed to fetch" beside a working `curl` — and whether that request
          // is same-origin or cross-origin is the whole diagnosis, so the panel states it.
          `board unavailable: ${state.lastError ?? 'unknown'} — tried ${state.origin.origin}${API_PREFIX} · document ${state.origin.document.protocol} ${state.origin.document.origin} · host origin from ${state.origin.source} · base ${state.origin.document.baseURI}`
        )
      : React.createElement(
          'div',
          { className: 'kb-lanes' },
          columns.map((column) => React.createElement(Lane, { key: column.state, ...child, column, drag, setDrag }))
        ),
    React.createElement(SprintBar, child),
    // Keyed by card, so opening a different card hands focus to the new drawer rather than reusing
    // the old one's focus-return target.
    task === undefined ? null : React.createElement(Drawer, { ...child, task, key: task.id })
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
