/**
 * Drag state, as data.
 *
 * The handlers in `components.ts` do three things and no more: translate a DOM event into one of
 * these calls, render the result, and hand the drop to the store. Every decision — which card,
 * which column, which index, whether the move is allowed — lives here, because jsdom's drag events
 * are unreliable enough that logic inside a handler cannot be trusted by a test.
 *
 * The drop index is computed from **pointer position against the card midpoints**, which is what
 * makes a drop land where the human saw the gap appear rather than at the end of the column.
 */
import type { State, Task } from '../store/types.js';
import { BOARD_STATES } from './model.js';

export interface DragState {
  readonly taskId: string;
  readonly fromState: State;
  readonly overState: State | null;
  readonly overIndex: number;
}

export const NO_DRAG: DragState | null = null;

export function beginDrag(taskId: string, fromState: State): DragState {
  return { taskId, fromState, overState: fromState, overIndex: 0 };
}

export function dragOver(state: DragState | null, toState: State, overIndex: number): DragState | null {
  if (state === null) return null;
  if (state.overState === toState && state.overIndex === overIndex) return state;
  return { ...state, overState: toState, overIndex };
}

/**
 * Where a card would land, given the pointer's Y against each card's midpoint.
 *
 * A card's own row is excluded before the index is computed, because the card is being dragged *out*
 * of the list it is measured against: comparing against itself would make the gap jump by one as
 * the pointer crosses its own midpoint.
 */
export function indexFromPointer(cards: readonly Task[], taskId: string, clientY: number, midpoints: readonly number[]): number {
  let index = 0;
  for (let position = 0; position < cards.length; position += 1) {
    if ((cards[position] as Task).id === taskId) continue;
    const midpoint = midpoints[position];
    if (midpoint !== undefined && clientY > midpoint) index += 1;
  }
  return index;
}

/** The payload for the store's `move`, or null when there is nothing to do. */
export function dropTarget(state: DragState | null): { taskId: string; toState: State; index: number } | null {
  if (state === null || state.overState === null) return null;
  return { taskId: state.taskId, toState: state.overState, index: state.overIndex };
}

/**
 * The keyboard equivalent of a drag: `Alt+←/→` moves a card one column along the board order.
 *
 * A drag-only board is unusable without a pointer, and the keyboard path is a full alternative
 * rather than a concession — it uses the same store call, so it goes through the same gates.
 */
export function keyboardTarget(from: State, direction: 'left' | 'right'): State | null {
  const index = BOARD_STATES.indexOf(from);
  if (index < 0) return null;
  const next = direction === 'left' ? index - 1 : index + 1;
  const target = BOARD_STATES[next];
  return target === undefined ? null : target;
}

/** Whether a card may be dropped on a column at all, for the lane's hover styling. */
export function isDropAllowed(from: State, to: State): boolean {
  if (from === to) return true;
  const fromIndex = BOARD_STATES.indexOf(from);
  const toIndex = BOARD_STATES.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return false;
  // Any column is a legal target — the gates decide, not the geometry — so the lane always
  // accepts the drop and the refusal comes back with a reason. Refusing by geometry would hide
  // why, and "cannot leave the backlog without the DoR" is the useful message.
  return true;
}
