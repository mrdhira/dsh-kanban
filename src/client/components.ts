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
 * is focusable, `Alt+←/→` moves it, `Enter` or `Space` opens it, and every state change is announced
 * through the panel's persistent `aria-live` region (see `BoardPage` for why there are three).
 */
import type { ReactElement } from 'react';
import type { BoardStore, BoardState } from './store.js';
import { selectedTask } from './store.js';
import { BOARD_STATES, DROPPED_FILTER, EMPTY_FILTER, actorKind, ageBand, ageDays, classLabel, columnsOf, filterStates, formatAge, formatPercent, formatStamp, hasFilter, moveTargets, priorityCode, priorityWord, sameFilter, type Column } from './model.js';
import { beginDrag, dragOver, dropTarget, indexFromPointer, isDropAllowed, keyboardTarget, type DragState } from './dnd.js';
import { API_PREFIX } from './api.js';
import { STYLES, STYLE_ID } from './styles.js';
import { CHECK_LABEL, CLASSES_OF_SERVICE, CLASS_LABEL, PRIORITIES, PRIORITY_LABEL, STATES, STATE_LABEL, type CheckId, type ClassOfService, type Priority, type State, type Task } from '../store/types.js';

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

/**
 * How the drawer that is on screen was opened: `keyboard` (Enter on a card) or `pointer` (a click).
 *
 * The drawer is focused programmatically, and whether a browser paints `:focus-visible` for a
 * script-driven `focus()` is not something the panel can rely on — so wherever it is, the keyboard
 * path can lose its ring. This records the one fact the browser does not expose here, and it is read
 * only while the drawer element mounts, so it cannot go stale between renders.
 */
let drawerOpenedByKeyboard = false;

/**
 * The empty board the pending state draws.
 *
 * Only the board's own state order is used — `filterStates(EMPTY_FILTER)`, the same five lanes the
 * real board draws — because that is all a pending column can honestly know: a state, a label and no
 * cards. **No limit is printed**: the Definition of Workflow arrives with the payload, and a pending
 * lane that printed `0/2` from this file's default could contradict the board it is standing in for.
 * So the loading state shows the same five lanes the real board will, each with one skeleton line
 * where a card will land, instead of an empty panel. Nothing else is invented: no card, no count, no
 * metric, no cap.
 */
function pendingColumns(): Column[] {
  return filterStates(EMPTY_FILTER).map((state) => ({
    state,
    label: STATE_LABEL[state],
    cards: [],
    limit: undefined,
    over: false,
  }));
}

// ------------------------------------------------------------------ chrome

/**
 * The toggle for a disclosure: `aria-expanded` is the whole state, and it is a real `<button>`.
 *
 * Not `<details>`: the opened half has to render as part of the row it belongs to (a metrics strip,
 * a drawer's move row) rather than inside a block box the browser styles, and a toggle whose open
 * state is testable DOM is worth more here than the platform's own widget. The label never changes
 * when it is used — a control that renames itself is two controls to a reader.
 *
 * The caret is what tells it apart from a pressed view at a glance: pressed and open now share the
 * tint, the stronger hairline and the weight, so without a shape cue the two states would be the same
 * picture. It is `aria-hidden`, so the accessible name stays exactly the label.
 */
function disclosureButton(
  React: ReactLike,
  props: {
    readonly label: string;
    readonly open: boolean;
    readonly action: string;
    readonly ariaLabel?: string;
    readonly onToggle: () => void;
  }
): ReactElement {
  return React.createElement(
    'button',
    {
      className: 'kb-btn kb-more',
      type: 'button',
      'data-action': props.action,
      'aria-expanded': props.open,
      ...(props.ariaLabel === undefined ? {} : { 'aria-label': props.ariaLabel }),
      onClick: props.onToggle,
    },
    props.label,
    React.createElement(
      'svg',
      {
        className: 'kb-more-caret',
        width: 9,
        height: 9,
        viewBox: '0 0 10 10',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      React.createElement('path', { d: 'M3.2 1.6 6.4 5 3.2 8.4' })
    )
  );
}

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
    // Nothing else here: a refusal is answered by editing the thing it named and the control that sent
    // it is still on screen, and a notice-level failure already has a recovery on the panel — the
    // header's `Refresh`. A second button beside `Dismiss` that did the same thing would be surface
    // with no new reach. The board-level error below is the case where nothing else is left to press.
    React.createElement('button', { className: 'kb-btn', type: 'button', onClick: () => store.notice(null) }, 'Dismiss')
  );
}

interface MetricsProps extends ChildProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly hostOpen: boolean;
  readonly onToggleHost: () => void;
}

function MetricsStrip(props: MetricsProps): ReactElement | null {
  const { React, state, open, onToggle, hostOpen, onToggleHost } = props;
  const payload = state.payload;
  if (payload === null) return null;
  const metrics = payload.metrics;
  const num = (value: number | null): string => (value === null ? '—' : String(value));
  // Two numbers at the front: how full the WIP control is, and how the oldest card reads against
  // the SLE. They answer *is anything stuck?* on their own; the history behind the toggle answers
  // *how has it been going?*, which is a second question and gets a second click.
  const wipLimit = payload.dow.wip['in-progress'] + payload.dow.wip.review;
  // `WIP 2/3` is the sum of two limbs, and the lane headers print those limbs separately (`2/2` and
  // `0/1`), so the lead can look self-contradictory next to them. The limbs are named in the span's
  // `title` rather than spelled out on the surface: the distill removed `(2/2 + 0/1)` from this line
  // for a reason, and a hover is enough to answer the question the eye just asked.
  const wipLimbs =
    `${STATE_LABEL['in-progress']} ${metrics.wipByState['in-progress'] ?? 0}/${payload.dow.wip['in-progress']}` +
    ` + ${STATE_LABEL.review} ${metrics.wipByState.review ?? 0}/${payload.dow.wip.review}`;
  // The store speaks in field values (`p85`, `guess`); a reader does not. `85th percentile` and
  // `from history`/`from default` are the same facts in the words the rest of the panel uses.
  const sleBasis = metrics.sle.source === 'history' ? 'from history' : 'from default';
  const lead = (label: string, value: string, hint?: string): ReactElement =>
    React.createElement(
      'span',
      { className: 'kb-metric-lead', ...(hint === undefined ? {} : { title: hint }) },
      React.createElement('b', null, label),
      ` ${value}`
    );
  const rest = (label: string, value: string): ReactElement =>
    React.createElement('span', { className: 'kb-dim' }, React.createElement('b', null, label), ` ${value}`);
  return React.createElement(
    'div',
    { className: 'kb-metrics', role: 'group', 'aria-label': 'Flow metrics' },
    lead('WIP', `${metrics.wip}/${wipLimit}`, wipLimbs),
    lead('Oldest', `${num(metrics.ageing.oldestDays)}d vs ${metrics.sle.days}d SLE · ${metrics.ageing.count} past`),
    disclosureButton(React, { label: 'More metrics', open, action: 'more-metrics', onToggle }),
    // The transport's address is developer text, so it lives beside the other slow, technical facts
    // rather than on the header's front line. `rev` is the same kind of fact and travels with it: the
    // error notice already names the URL, the origin and the document when any of that matters.
    disclosureButton(React, { label: 'Host', open: hostOpen, action: 'more-host', onToggle: onToggleHost }),
    open ? rest('Cycle', `median ${num(metrics.cycle.medianDays)}d · 85th percentile ${num(metrics.cycle.p85Days)}d · mean ${num(metrics.cycle.meanDays)}d`) : null,
    open ? rest('Throughput', `${metrics.throughput.days7}/7d · ${metrics.throughput.days30}/30d`) : null,
    // The three cycle readings are one fact told three ways — the disclosure exists to hold what the
    // front cannot, so it holds all of them rather than the median alone. The full metrics, including
    // each band's own basis, stay in `kanban_metrics`.
    open ? rest('SLE', `${formatPercent(metrics.sle.p)}% ≤ ${metrics.sle.days}d (${sleBasis})`) : null,
    hostOpen
      ? React.createElement('span', { className: 'kb-dim' }, `rev ${payload.rev} · host ${state.origin.origin} · ${state.origin.source}`)
      : null
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
 * and metrics belong to whatever font the host happens to load. One stroke width, drawn rather than
 * typed, and `aria-hidden` — `aria-pressed` on the button stays the only source of truth. The card's
 * completion mark is the same glyph; only its tick takes a second tone, and `.kb-mark-tick` is why.
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
    // The tick carries its own class so the card's frame and tick can hold different tones: on a done
    // *card* the frame is the app's green, which composites to only 2.28:1 on the light card's white,
    // and a mark below the graphical floor is a mark half the readers cannot see. The tick is the part
    // that must be legible, so on a card it takes the ordinary foreground (18.90:1 light); the frame
    // keeps the success meaning. Nothing else changes: a checklist row's glyph sets no `.kb-mark`, so
    // its tick is simply `currentColor` as it always was, and its state is `aria-pressed` plus the
    // words `· unticked`.
    checked ? React.createElement('path', { className: 'kb-mark-tick', d: 'M5 8.2 7.4 10.6 11 5.6' }) : null
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
  // A dropped card says so by its whole card: dim, and beside the drawn tick, the one state that is
  // neither a warning nor a verdict. It is only ever on screen in the Dropped view.
  if (task.state === 'dropped') classes.push('kb-card-dropped');
  // The top row holds the id, the priority code and the age inside a 236px lane, so it keeps the
  // numbers and the words move down to the chip row, which wraps without breaking a token. The words
  // are what keep the meaning alive without colour (amber cannot carry small text on white: 2.15:1
  // measured), so where a colour carries a state the word stays — relocated, never dropped. What the
  // chip row no longer repeats is the card's filing: class, assignee, project, sprint live in the
  // drawer, which has room to print them in full.
  const age = formatAge(days);
  const priorityLabel = priorityWord(task.priority);
  const ageLabel = band === 'fresh' ? null : band;
  /**
   * The chip row carries only what asks for a decision: a blocker, a P0/P1 word, an age band that
   * has left `fresh`, and `expedite` — the one class of service with a consequence, since it is the
   * only exception to a WIP limit. Class, assignee, project and sprint are facts about the card,
   * not about what to do next, and the drawer already prints every one of them.
   *
   * `expedite` stays although it is a class, because the card's other expedite signal is a red
   * hairline — and a state that is only a colour is not a state a reader can be relied on to see.
   */
  const chips: ReactElement[] = [];
  if (task.blockedReason !== null) chips.push(React.createElement('span', { className: 'kb-chip', key: 'blocked' }, 'blocked'));
  if (priorityLabel !== null) chips.push(React.createElement('span', { className: 'kb-chip', key: 'priority' }, priorityLabel));
  if (ageLabel !== null) chips.push(React.createElement('span', { className: 'kb-chip', key: 'age' }, ageLabel));
  if (task.classOfService === 'expedite') {
    chips.push(React.createElement('span', { className: 'kb-chip', key: 'class' }, classLabel(task)));
  }

  const onKeyDown = (event: { key: string; altKey: boolean; preventDefault: () => void }): void => {
    // APG's button pattern is Enter *and* Space. A `role="button"` div is not a real `<button>`, so
    // nothing synthesises the Space click the browser would give one; without this branch Space
    // scrolled the page instead of opening the card, and PRODUCT.md's operator parity was a claim
    // about the pointer's actions that the keyboard could not keep. Both keys take the same path.
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      // The panel is about to move the keyboard into the drawer itself, and a programmatic focus is
      // exactly the case a browser may not paint a ring for. Claim it here, where the cause is known.
      drawerOpenedByKeyboard = true;
      void store.select(task.id);
      return;
    }
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const target = keyboardTarget(task.state, event.key === 'ArrowLeft' ? 'left' : 'right');
      if (target === null) {
        // A dropped card is not at an edge — it is not on the board at all. Saying "edge of the
        // board" of a card the board refuses to draw is the kind of small lie this panel avoids.
        onAnnounce(
          task.state === 'dropped'
            ? `${task.id} is dropped — open it and move it back to the board`
            : `${task.id} is already at the edge of the board`
        );
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
        // A click that arrives while *this card's own* drawer already holds focus is not the pointer
        // opening a new one, so it does not clear the keyboard's claim. Every other click does — in
        // particular a click on a different card, whose keyed drawer replaces the one on screen, so
        // keeping the flag there would paint a pointer-opened drawer with the keyboard ring. Read
        // duck-typed rather than through `instanceof HTMLElement`: the bundle is evaluated in a
        // realm that does not have the Node global (the harness relies on that).
        const active: { readonly className?: unknown } | null = document.activeElement;
        const drawerHoldsFocus = typeof active?.className === 'string' && active.className.includes('kb-drawer');
        if (!(drawerHoldsFocus && state.selectedId === task.id)) {
          drawerOpenedByKeyboard = false;
        }
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
      React.createElement('span', { className: `kb-age-${band}` }, age)
    ),
    React.createElement('div', { className: 'kb-card-title' }, task.title),
    // No chips, no empty row: a card with nothing to flag is id, priority code, age and title.
    chips.length === 0 ? null : React.createElement('div', { className: 'kb-card-meta' }, ...chips)
  );
}

interface LaneProps extends ChildProps {
  readonly column: Column;
  readonly drag: DragState | null;
  readonly setDrag: (next: DragState | null) => void;
  readonly cardNodes: CardNodes;
  /** True while the first payload is still in flight: the lane draws a skeleton instead of a verdict. */
  readonly loading: boolean;
}

function Lane(props: LaneProps): ReactElement {
  const { React, state, store, column, drag, setDrag, onAnnounce, cardNodes, loading } = props;
  // A ref to the lane's card list, so a drop lands where the gap appeared rather than at the end.
  const cardsRef = React.useRef<{ children?: ArrayLike<{ getBoundingClientRect(): { top: number; height: number } }> } | null>(null);
  // Each card's midpoint, measured once per drag rather than once per `dragover`. The cards do not
  // move while a drag is live — the row changes class and the lanes change width, but a card's own
  // rect is stable for the duration — so re-reading every card on every event was layout work whose
  // answer could not have changed. `cards` is the count the cache was built for: a lane whose card
  // count changed (a drop landed, a poll arrived) invalidates it rather than answering from stale
  // geometry. Today's ~20 cards made this waste small; it was waste all the same.
  const midpoints = React.useRef<{ cards: number; values: number[] }>({ cards: -1, values: [] });
  // The drop affordance is the lane a drop is allowed on and is currently over — `isDropAllowed`
  // states the "allowed" half, so a lane that could not take the card never lights up for it.
  const isOver = drag !== null && isDropAllowed(drag.fromState, column.state) && drag.overState === column.state;

  const indexAt = (clientY: number): number => {
    const container = cardsRef.current;
    if (container?.children === undefined) return column.cards.length;
    if (midpoints.current.cards !== column.cards.length) {
      midpoints.current = {
        cards: column.cards.length,
        values: Array.from(container.children).map((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top + rect.height / 2;
        }),
      };
    }
    return indexFromPointer(column.cards, drag?.taskId ?? '', clientY, midpoints.current.values);
  };

  const classes = ['kb-lane'];
  if (isOver) classes.push('kb-lane-over');
  if (column.over) classes.push('kb-lane-over-limit');
  // A lane with nothing in it is a rail, not a column: four empty lanes holding 236px each is what
  // forces the sideways scroll to scroll for nothing. It opens up again the moment a drag starts,
  // because a drop target you cannot hit is not a drop target.
  if (column.cards.length === 0) classes.push('kb-lane-empty');
  if (column.cards.length === 0 && drag !== null) classes.push('kb-lane-awake');
  // The accessible name has to say what the eye is given. The header prints `1/5` and, past the cap,
  // an `over limit` chip, while the name said only "Ready, 1 card(s)" — a reader was told less than
  // the picture, and `card(s)` is a store plural, not a word. The name now carries the count, the
  // limit whenever the state has one, and the warning in words whenever it is over.
  const laneName =
    `${column.label}, ${column.cards.length} ${column.cards.length === 1 ? 'card' : 'cards'}` +
    (column.limit === undefined ? '' : `, limit ${column.limit}`) +
    (column.over ? ', over the limit' : '');

  return React.createElement(
    'div',
    {
      className: classes.join(' '),
      'data-lane': column.state,
      // The lane was an identity-less `div` carrying a name, which ARIA 1.2's generic role prohibits
      // — the name was inert to assistive technology. `group` is the role it actually is: a named
      // collection of cards. `aria-keyshortcuts` used to sit here too, on a lane that is never
      // focusable, where no reader could act on it; the card that *is* focusable already declares the
      // same shortcut, and the drawer's own hint spells it out.
      role: 'group',
      'aria-label': laneName,
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
      // The one chip that is a warning, not a fact: same colour and weight as the red count beside
      // it, so an over-limit lane reads as one signal told twice rather than a coloured number
      // beside a chip that looked like every other chip.
      column.over ? React.createElement('span', { className: 'kb-chip kb-chip-warn' }, 'over limit') : null
    ),
    React.createElement(
      'div',
      { className: 'kb-cards', ref: cardsRef },
      column.cards.length > 0
        ? column.cards.map((task) =>
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
        : // Pending is not empty. A skeleton line is drawn where a card will land, so the lane is
          // never read as the answer while the first payload is still in flight; `aria-busy` on the
          // row above is the announced half of the same state.
          loading
          ? React.createElement('div', { className: 'kb-skeleton', 'aria-hidden': 'true' })
          : React.createElement('div', { className: 'kb-empty' }, 'nothing here')
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
  const { React, state, store, task, gate, items } = props;
  const checked: Record<string, unknown> = gate === 'dor' ? { ...task.dor } : { ...task.dod };
  return React.createElement(
    'div',
    // `role="group"` for the same reason as the metrics strip and the lane: a name on a role-less
    // `div` is prohibited by ARIA 1.2, and these rows are exactly a named group of one gate's items.
    { className: 'kb-checks', role: 'group', 'aria-label': gate === 'dor' ? 'Definition of Ready' : 'Definition of Done' },
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
          // A tick that cannot land is the defect this prevents: while a mutation is in flight the
          // write's own optimistic update has not been confirmed, so a second tick would be sent
          // against a revision the host is already answering. The row is present but inert, and --
          // because a ticked row is `aria-pressed="true"` -- it is the one button that is both
          // chosen and disabled, which the sheet's `[aria-pressed="true"]:disabled` rule exists for.
          disabled: state.busy,
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
  const [moreOpen, setMoreOpen] = React.useState(false);
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

  /**
   * The drawer's move set.
   *
   * **One primary move**, the next state in the board's own order — that is the answer to "what
   * happens to this card next?" nine times in ten. Every other target is one click behind `More…`
   * beside it, so nothing became unreachable; it only stopped competing. `dropped` is not in this
   * menu at all: a drop is reached through Drop and its reason, at the bottom.
   *
   * A card whose state is not on the board — a dropped one, seen in the Dropped view — has no "next
   * lane", so the primary move is the way back in: the first lane. Without that the drawer of a
   * dropped card offered `Close` and nothing else, which is the same defect as having no view at all,
   * one layer deeper.
   */
  const here = BOARD_STATES.indexOf(task.state);
  const next =
    here >= 0 && here + 1 < BOARD_STATES.length
      ? (BOARD_STATES[here + 1] as State)
      : here < 0
        ? (BOARD_STATES[0] as State | undefined) ?? null
        : null;
  const otherMoves = BOARD_STATES.filter((target) => target !== task.state && target !== next);
  const moveButton = (target: State): ReactElement =>
    React.createElement(
      'button',
      {
        key: target,
        className: 'kb-btn',
        type: 'button',
        // `→ ready` is unreadable out of context; the label says which card and where.
        'aria-label': `Move ${task.id} to ${STATE_LABEL[target]}`,
        onClick: () => {
          // The announcer carries the intent; a refusal follows through the notice strip, so this is
          // never the last word on a move the host rejected.
          onAnnounce(`moving ${task.id} to ${STATE_LABEL[target]}`);
          void store.move(task.id, target);
        },
      },
      `→ ${STATE_LABEL[target]}`
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
    {
      className: 'kb-drawer',
      'data-drawer': task.id,
      // A region, not an anonymous box: the drawer is the one part of the panel that replaces the
      // board's meaning with a single card's, and a reader who jumps by landmark should find it by
      // name. `aria-label` on a role-less `div` is prohibited, which is what an unnamed region was.
      role: 'region',
      'aria-label': `${task.id} ${task.title}`,
      // Read once, at mount: this element is keyed by card, so a new drawer re-reads it and the open
      // drawer keeps the answer it was given. The stylesheet uses it to draw the ring the browser may
      // decline to draw for the programmatic focus below.
      'data-open': drawerOpenedByKeyboard ? 'keyboard' : 'pointer',
      tabIndex: -1,
      ref: drawerRef,
      onKeyDown,
    },
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
      : React.createElement(
          'div',
          { className: 'kb-notice kb-notice-refusal' },
          React.createElement('span', null, `Blocked: ${task.blockedReason}`),
          React.createElement('span', { className: 'kb-spacer' }),
          // The way out sits on the notice that names the stuck state. A blocked card is the one
          // case where the single obvious move is not a move at all, so the fix is not buried in
          // `More…` with the action that caused it.
          React.createElement(
            'button',
            { className: 'kb-btn', type: 'button', 'data-action': 'unblock', onClick: () => void store.unblock(task.id) },
            'Unblock'
          )
        ),
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
        next === null ? null : moveButton(next),
        disclosureButton(React, {
          label: 'More moves…',
          open: moreOpen,
          action: 'more',
          // The visible text stays inside the accessible name, so speech control still finds it.
          ariaLabel: `More moves for ${task.id}`,
          onToggle: () => setMoreOpen(!moreOpen),
        })
      ),
      moreOpen
        ? React.createElement(
            'div',
            { className: 'kb-fold' },
            // Every other target stays here, so `More…` widens the choice rather than replacing it.
            otherMoves.length === 0
              ? null
              : React.createElement('div', { className: 'kb-bar' }, ...otherMoves.map(moveButton)),
            // Reordering is not pointer-only: a position is a number, and `kanban_move.toPosition`
            // is the same number.
            React.createElement(
              'div',
              { className: 'kb-bar' },
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
              )
            ),
            // The exception is the one path an agent has and a drag does not, so it is explicit,
            // needs a written reason, and still goes through `checkMoveLocally` and then the host.
            React.createElement(
              'div',
              { className: 'kb-bar' },
              React.createElement(
                'button',
                {
                  className: 'kb-btn',
                  type: 'button',
                  'data-action': 'exception',
                  'aria-expanded': exceptionOpen,
                  onClick: () => setExceptionOpen(!exceptionOpen),
                },
                'Exception to a gate…'
              )
            ),
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
                      onChange: (event: { target: { value: string } }) =>
                        setExceptionTarget(event.target.value as State),
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
                        // Deliberately not cleared: if the host refuses, the human must still see
                        // the reason they wrote rather than an empty box beside the refusal.
                        void store.move(task.id, exceptionTo, undefined, {
                          force: true,
                          reason: exceptionReason.trim(),
                        });
                      },
                    },
                    'Move with exception'
                  )
                )
              : null,
            React.createElement(
              'div',
              { className: 'kb-group' },
              React.createElement('span', { className: 'kb-dim' }, 'block'),
              React.createElement(
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
                // unavailable in the desktop renderer and untestable under jsdom, and the reason is
                // evidence the board keeps forever. The button stays disabled until there is one.
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
            )
          )
        : null
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
              {
                className: 'kb-mono kb-dim',
                key: String(entry.id),
                // The store writes the actor as `kind:id` — `agent:01J…`, a raw session id, which is
                // not a word for a human to read. The row prints the *kind* and keeps the id in the
                // title, where a reader who wants to know which session moved the card can find it.
                title: entry.actor,
              },
              `${formatStamp(entry.at)} ${entry.kind}${entry.toState === null ? '' : ` → ${STATE_LABEL[entry.toState]}`} (${actorKind(entry.actor)})`
            )
          )
        )
  );
}

// ------------------------------------------------------------------ the panel

/**
 * The whole panel.
 *
 * **Three live regions, deliberately, and this comment used to claim one.** The announcer below is
 * the persistent one — it is rendered on every pass, empty or not, because a region that appears with
 * its first message is a region many screen readers never announce. The other two are conditional
 * *states* of the panel, not announcements: a notice (a refusal, an informational line) and the
 * board-level error. Both are `role="status"` because the thing they say is the thing that changed,
 * and they carry no second copy in the announcer, so no message is ever spoken twice.
 */
export function BoardPage(props: BoardProps): ReactElement {
  const { React, store, documentRef } = props;
  if (store === undefined) throw new Error('the kanban panel was mounted without its store');
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const [draft, setDraft] = React.useState('');
  /**
   * What each disclosure is showing.
   *
   * Two small ones — the flow history and the host line — and the state lives here rather than in a
   * `<details>` so the revealed half renders inline, in the row it belongs to.
   */
  const [metricsOpen, setMetricsOpen] = React.useState(false);
  const [hostOpen, setHostOpen] = React.useState(false);
  /** Live card nodes, so a closing drawer can return focus to the card it was opened from. */
  const cardNodes = React.useRef<Map<string, CardNode>>(new Map());

  React.useEffect(() => store.start(), [store]);

  /**
   * The announcer says a thing once; it does not keep it.
   *
   * The region must be mounted on every pass so a reader has something to announce *into*, but a
   * message left there is stale the moment the move it describes has landed — the stray
   * `moving T-004 to review` line outlived the move. So the text is cleared after a bound: long
   * enough for a polite region to be read, short enough that the message is not still in the DOM
   * when the board has moved on. Clearing does not un-announce it; the region stays mounted.
   */
  React.useEffect(() => {
    if (announcement.length === 0) return;
    const timer = setTimeout(() => setAnnouncement(''), 5000);
    return () => clearTimeout(timer);
  }, [announcement]);

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

  /**
   * Two pending states, both already in the store and neither rendered before this pass:
   * `loading` is the first payload in flight (the header says `connecting…`), `busy` is a write in
   * flight. They are drawn on the board row — a dim, `aria-busy` board — because that row is the one
   * thing on screen in every layout. The lanes are still drawn while the first read is in flight (an
   * empty lane row with one skeleton line each), which is the whole point: they show what is coming
   * rather than an empty panel, and no card is invented to fill them.
   */
  const loading = state.status === 'loading';
  const busy = loading || state.busy;
  const columns = state.payload === null ? (loading ? pendingColumns() : []) : columnsOf(state.payload, state.filter);
  const shown = columns.reduce((total, column) => total + column.cards.length, 0);
  const total = state.payload?.total ?? 0;
  const filtered = hasFilter(state.filter);
  // The view row's one narrowing control. The state chip row was distilled away on purpose — the
  // view buttons are the panel's state filtering — but that cut removed the only path a human had to
  // a *single* state, which made "only Done" an agent's `kanban_list({ state: … })` and nobody
  // else's. One select restores it and adds no row: the primitive was already in the sheet.
  const narrowedState = state.filter.state !== undefined && state.filter.state.length === 1 ? state.filter.state[0] : '';
  const task = selectedTask(state);
  const onAnnounce = (message: string): void => setAnnouncement(message);
  const child = { React, state, store, onAnnounce, cardNodes };

  return React.createElement(
    'div',
    { className: 'kb-page' },
    React.createElement(
      'div',
      { className: 'kb-head' },
      React.createElement('h1', { className: 'kb-title' }, state.payload?.title ?? 'Kanban'),
      // The count line folds the filter's own answer into what is drawn, so a narrowed board says so
      // in the header instead of in a row of its own. The test is `shown !== total`, not `filtered`:
      // an unfiltered board still draws fewer cards than the host holds when one is `dropped` (it has
      // no lane) or the read was truncated, and a header that said "6 cards" over five drawn cards is
      // the kind of small lie this board exists to avoid. **The revision is not here**: `rev 7` is
      // developer vocabulary on the operator's front line, so it travels with the host line behind
      // the `Host` disclosure in the metrics strip.
      React.createElement(
        'span',
        { className: 'kb-sub' },
        state.payload === null
          ? 'connecting…'
          : filtered || shown !== total
            ? `showing ${shown} of ${total} cards`
            : `${total} cards`
      ),
      React.createElement('span', { className: 'kb-spacer' }),
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
      // One filter control, not two: the views below are the panel's state filtering. The chip row
      // that used to sit here repeated the lane headers and the views, and it is gone. `All` is not
      // one of the saved views — a board seeded with Board and Ageing has no unfiltered view — so it
      // stays as the way back out of both, and the only way to see finished cards from the panel.
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
          {
            className: 'kb-btn',
            type: 'button',
            'data-action': 'all',
            // `!filtered`, not `sameFilter(...)`: a *search-only* filter draws exactly the same lanes
            // as no filter, so no view is pressed and `All` is the one control that can be said to be
            // showing — pressing it is what clears the box. Marking nothing pressed while the board is
            // narrowed by text would leave the row with no answer to "which of these am I in?".
            'aria-pressed': !filtered,
            onClick: () => store.setFilter(EMPTY_FILTER),
          },
          'All'
        ),
        // `dropped` has no lane on the board — by design, and the brief for this pass repeats it — but
        // a card can be dropped from the drawer and the state had no view, so a dropped card left the
        // panel and the only way back to it was the CLI. This is the narrowest fix: not a sixth lane,
        // just a view that names the one state the board refuses to draw. It is a peer of the saved
        // views and `All` rather than a new control, and `All` keeps its escape role unchanged.
        React.createElement(
          'button',
          {
            className: 'kb-btn',
            type: 'button',
            'data-action': 'dropped',
            'aria-pressed': sameFilter(state.filter, DROPPED_FILTER),
            onClick: () => store.setFilter(DROPPED_FILTER),
          },
          'Dropped'
        )
      ),
      // The one narrowing control the view row gets, and the only new surface this pass adds: a
      // `select.kb-input` listing every state. Choosing one narrows the board to that state alone
      // (choosing the empty option clears the filter, exactly as `All` does). No chip row returns:
      // per-state chips are a second surface for a question one picker answers.
      React.createElement(
        'select',
        {
          className: 'kb-input',
          'data-select': 'view-state',
          'aria-label': 'Narrow to one state',
          value: narrowedState,
          onChange: (event: { target: { value: string } }) => {
            const chosen = event.target.value;
            store.setFilter(chosen.length === 0 ? EMPTY_FILTER : { state: [chosen as State] });
          },
        },
        React.createElement('option', { value: '' }, filtered ? 'current view' : 'all states'),
        ...STATES.map((entry) => React.createElement('option', { key: entry, value: entry }, STATE_LABEL[entry]))
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
      // Creation takes a title and nothing else. The two fields it used to carry (priority, class)
      // are the store's defaults here — `p2-normal` / `standard`, applied by `kanban_create` — and
      // the drawer sets both one step later, so the first row of the panel stops being four controls.
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
    React.createElement(MetricsStrip, {
      ...child,
      open: metricsOpen,
      onToggle: () => setMetricsOpen(!metricsOpen),
      hostOpen,
      onToggleHost: () => setHostOpen(!hostOpen),
    }),
    // The announcer, present on every pass whether or not it has anything to say: a live region that
    // is inserted with its first message is a live region several screen readers never announce. It
    // is visually hidden — `.kb-vh`, the sheet's one utility class — so the strip paints nothing and
    // takes no room in the page's 10px gap, and its last message is cleared after a bound rather than
    // left in the DOM as stale text a reader could walk back into.
    React.createElement('div', { className: 'kb-vh', role: 'status', 'aria-live': 'polite' }, announcement),
    state.status === 'error' && state.payload === null
      ? React.createElement(
          'div',
          { className: 'kb-notice kb-notice-error', role: 'status', 'aria-live': 'polite' },
          // Name everything a reader needs to tell "the route is down" from "the browser blocked it":
          // the URL attempted, the origin it came from, and what the *document* says it is. The first
          // live failure said only "Failed to fetch" beside a working `curl` — and whether that request
          // is same-origin or cross-origin is the whole diagnosis, so the panel states it.
          `board unavailable: ${state.lastError ?? 'unknown'} — tried ${state.origin.origin}${API_PREFIX} · document ${state.origin.document.protocol} ${state.origin.document.origin} · host origin from ${state.origin.source} · base ${state.origin.document.baseURI}`,
          // The error is a state with an answer, not only a sentence: the same Refresh the header
          // carries, on the notice that names the failure. It says so in words and it is a real button,
          // so the recovery is not a colour or a guess.
          React.createElement(
            'button',
            {
              className: 'kb-btn',
              type: 'button',
              'data-action': 'retry-board',
              onClick: () => void store.refresh(true),
            },
            'Retry'
          )
        )
      : React.createElement(
          'div',
          {
            className: `kb-lanes${busy ? (loading ? ' kb-lanes-loading' : ' kb-lanes-busy') : ''}`,
            // The board a mutation is in flight against is the board the human should not trust for a
            // moment; `aria-busy` is how that is said to a reader who cannot see the dimming.
            'aria-busy': busy,
          },
          columns.map((column) => React.createElement(Lane, { key: column.state, ...child, column, drag, setDrag, loading }))
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
