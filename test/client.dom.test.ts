/**
 * The board panel under jsdom.
 *
 * This is the closest thing to the human's screen that can run in a test: the **real** bundle, the
 * **real** transport, the **real** store and the **real** components, with only `fetch` faked. So
 * these cases cover the parts a pure test cannot — that the URL is built correctly, that a refusal
 * rolls the card back and says why, that a drag ends in the right mutation, and that the keyboard
 * path goes through exactly the same gates as the pointer.
 *
 * Ordering follows the code flow: registration, then the first render, then interaction, then the
 * refusals. Every assertion compares primitives — a DOM node handed to `assert` makes the runner
 * walk React's fibers, which once allocated gigabytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  boardPayload,
  flush,
  freshStore,
  lastMutation,
  loadBundle,
  mount,
  recorded,
  respondWithBoard,
  setFetch,
  type LoadedBundle,
  type MountedView,
  type RecordedCall,
} from './harness.ts';
import { resolveOrigin } from '../lib/v1/client/api.js';
import { createBoardStore } from '../lib/v1/client/store.js';
import { DROPPED_FILTER, EMPTY_FILTER, checkMoveLocally, columnsOf, filterStates, sameFilter } from '../lib/v1/client/model.js';
import { PRIORITIES } from '../lib/v1/store/index.js';

const FULL_DOR = Object.fromEntries(
  ['outcome', 'acceptance', 'write-scope', 'estimate'].map((id) => [id, { at: '2026-10-01T00:00:00.000Z', by: 'human:dhira' }])
);

/** A filter the store reports as the current view: a ready card and everything past the gate. */
const READY_VIEW = { state: ['ready', 'in-progress', 'review', 'done'] };

/**
 * The two views every new board is seeded with, as the host sends them.
 *
 * `All` is deliberately **not** among them: it is the panel's own clear-the-filter control. That is
 * why it survives the distill pass — without it, choosing `Board` would be a one-way door and the
 * finished cards would be unreachable from the panel.
 */
const SEEDED_VIEWS = [
  { id: 'board', name: 'Board', description: 'everything still moving', filter: { state: ['backlog', 'ready', 'in-progress', 'review'] } },
  { id: 'ageing', name: 'Ageing', description: 'started, not finished', filter: { state: ['in-progress', 'review'] } },
];

/**
 * The board the DOM tests render: one refined backlog card, one ready, two in progress, one done, and
 * one **dropped** card — the state the board has no lane for, and the reason the `Dropped` view has to
 * exist: without it the card is in the store, in the counts and in the metrics, and nowhere on screen.
 */
function fixture(): Record<string, unknown> {
  const payload = boardPayload();
  const tasks = (payload.tasks as Record<string, unknown>[]).map((task) =>
    task.id === 'T-001' ? { ...task, dor: FULL_DOR } : task
  );
  return {
    ...payload,
    tasks: [...tasks, { ...(tasks[0] as Record<string, unknown>), id: 'T-006', state: 'dropped', position: 0, droppedReason: 'superseded' }],
    total: 6,
  };
}

/**
 * Mount the panel with a **store of its own**.
 *
 * The bundle is evaluated once per realm, so its own store is a singleton; sharing it would let one
 * test's board, filter, selection and polling leak into the next, which is exactly how three of
 * these cases failed the first time they ran.
 */
async function mountBoard(loaded: LoadedBundle, payload: Record<string, unknown> = fixture()): Promise<MountedView> {
  respondWithBoard(payload);
  const view = mount(loaded, loaded.slot('main'), { store: freshStore(loaded) });
  await flush();
  return view;
}

// ------------------------------------------------------------------ registration

test('the bundle registers the sidebar entry and the panel under one id', () => {
  const loaded = loadBundle();
  const entry = loaded.slot('sidebar.panellist');
  assert.equal(entry.spec.id, 'kanban');
  // Below Automation tasks (the schedules entry, order 10), which is where Dhira asked for it.
  assert.equal(entry.spec.order, 20);
  assert.ok(entry.spec.order > 10, 'and it must stay below the shipped entries');
  assert.equal(typeof entry.spec.label === 'function' ? (entry.spec.label as () => string)() : entry.spec.label, 'Kanban');

  // The sidebar address and the main panel key must be the same string: that is how the shell
  // knows which panel an icon opens.
  assert.equal(loaded.slot('main').spec.key, 'kanban');
});

test('the client half injects only slots', () => {
  assert.equal(String(loadBundle().inject), 'slots');
});

// ------------------------------------------------------------------ first render

test('the panel draws one lane per board state, in board order', async () => {
  const view = await mountBoard(loadBundle());
  const lanes = view.findAll('[data-lane]').map((node) => node.getAttribute('data-lane'));
  assert.deepEqual(lanes, ['backlog', 'ready', 'in-progress', 'review', 'done']);
  view.unmount();
});

test('cards are drawn in their own lane, expedite first', async () => {
  const view = await mountBoard(loadBundle());
  const inProgress = view.find('[data-lane="in-progress"]');
  const ids = [...(inProgress?.querySelectorAll('[data-card]') ?? [])].map((node) => node.getAttribute('data-card'));
  assert.deepEqual(ids, ['T-004', 'T-003'], 'the expedite card leads, whatever its priority or position');
  assert.equal(view.has('[data-card="T-001"]'), true);
  view.unmount();
});

test('the WIP badge shows occupancy against the limit', async () => {
  const view = await mountBoard(loadBundle());
  const lane = view.find('[data-lane="in-progress"]');
  assert.match(lane?.textContent ?? '', /2\/2/);
  view.unmount();
});

test('a lane past its limit says so', async () => {
  const payload = fixture();
  const tasks = payload.tasks as Record<string, unknown>[];
  const extra = { ...(tasks[0] as Record<string, unknown>), id: 'T-099', state: 'review', position: 0 };
  const overLimit = { ...payload, tasks: [...tasks, extra, { ...extra, id: 'T-098' }] };
  const view = await mountBoard(loadBundle(), overLimit);
  const lane = view.find('[data-lane="review"]');
  assert.equal(lane?.className.includes('kb-lane-over-limit'), true);
  // The word is not an ordinary chip: it carries the warning class, so the over-limit lane is one
  // signal told twice (the red count and the coloured, weighted chip) instead of a coloured number
  // beside a chip that looked like every other chip.
  assert.equal(lane?.querySelector('.kb-chip-warn')?.textContent, 'over limit');
  view.unmount();
});

test('the header names the revision it is showing, and the host line waits behind its disclosure', async () => {
  const view = await mountBoard(loadBundle());
  assert.match(view.text(), /rev 7/);
  // The transport's URL is developer text and it does not sit in the most prominent row of a task
  // board. The error notice below still names it, so nothing diagnostic is lost.
  assert.equal(view.text().includes('host http://localhost'), false, 'the host line is not on the front');
  assert.equal(view.find('[data-action="more-host"]')?.getAttribute('aria-expanded'), 'false');

  await view.click('[data-action="more-host"]');
  await flush();
  assert.equal(view.find('[data-action="more-host"]')?.getAttribute('aria-expanded'), 'true');
  assert.match(view.text(), /host http:\/\/localhost/);
  view.unmount();
});

test('the header count matches what is drawn, not what the host holds', async () => {
  // The fixture holds six cards and the board draws five: the sixth is dropped, and the board has no
  // lane for it. The header used to print "6 cards" over five drawn cards. A count that disagrees
  // with the screen is the kind of small lie this board exists to avoid, so the unfiltered header
  // states both numbers whenever the board cannot draw everything it holds.
  const view = await mountBoard(loadBundle());
  assert.equal(view.findAll('[data-card]').length, 5, 'five cards are drawn');
  assert.match(view.text(), /rev 7 · showing 5 of 6 cards/, 'and the header accounts for the sixth');
  assert.equal(view.text().includes('rev 7 · 6 cards'), false, 'never a total that disagrees with the screen');

  // A board that draws every card it holds keeps the short form rather than a redundant "5 of 5".
  const whole = await mountBoard(loadBundle(), boardPayload());
  assert.match(whole.text(), /rev 7 · 5 cards/);
  whole.unmount();
  view.unmount();
});

test('two numbers lead the metrics and the history opens behind one control', async () => {
  const view = await mountBoard(loadBundle());
  const front = view.text();
  assert.match(front, /WIP 2\/3/);
  assert.match(front, /Oldest 1\.5d vs 3d SLE/);
  assert.equal(view.findAll('.kb-metric-lead').length, 2, 'exactly two items lead the scan');
  assert.equal(front.includes('Cycle'), false, 'the history is not competing with them');
  assert.equal(front.includes('Throughput'), false);
  assert.equal(front.includes('p85'), false, 'the 85th percentile is not on the front line');
  assert.equal(view.find('[data-action="more-metrics"]')?.getAttribute('aria-expanded'), 'false');

  await view.click('[data-action="more-metrics"]');
  await flush();
  assert.equal(view.find('[data-action="more-metrics"]')?.getAttribute('aria-expanded'), 'true');
  const opened = view.text();
  // The disclosure holds all three cycle readings, not the median alone: the payload has them, and
  // the history behind the disclosure is exactly where a second and third reading belong.
  assert.match(opened, /Cycle median 3d · p85 3d · mean 3d/);
  assert.match(opened, /Throughput 1\/7d · 1\/30d/);
  assert.match(opened, /SLE 85% ≤ 3d/);
  view.unmount();
});

test('a metric the store cannot compute is an em dash, not a zero', async () => {
  // `null` is "no finished card to measure", which is not the same claim as `0d`, and the disclosure
  // prints the distinction rather than inventing a number the board does not have.
  const payload = boardPayload();
  const metrics = { ...(payload.metrics as Record<string, unknown>), cycle: { count: 0, medianDays: null, p85Days: null, meanDays: null, minDays: null, maxDays: null } };
  const view = await mountBoard(loadBundle(), { ...fixture(), metrics });
  await view.click('[data-action="more-metrics"]');
  await flush();
  assert.match(view.text(), /Cycle median —d · p85 —d · mean —d/);
  view.unmount();
});

test('a board the host cannot answer shows why, rather than an empty lane', async () => {
  setFetch(() => ({ status: 500, body: { ok: false, message: 'boom' } }));
  const view = mount(loadBundle(), loadBundle().slot('main'), { store: freshStore(loadBundle()) });
  await flush();
  assert.equal(view.has('.kb-notice-error'), true);
  assert.match(view.text(), /board unavailable/);
  view.unmount();
});

// ------------------------------------------------------------------ interaction

test('typing in the search box narrows the board', async () => {
  const view = await mountBoard(loadBundle());
  assert.equal(view.has('[data-card="T-005"]'), true);
  await view.type('input[type="search"]', 'T-003');
  await flush();
  assert.equal(view.has('[data-card="T-003"]'), true);
  assert.equal(view.has('[data-card="T-005"]'), false, 'a filtered-out card is gone');
  view.unmount();
});

test('Alt+ArrowRight moves a card one lane along, through the same route as a drag', async () => {
  const view = await mountBoard(loadBundle());
  await view.key('[data-card="T-001"]', 'ArrowRight', { altKey: true });
  await flush();
  const mutation = lastMutation();
  assert.equal(mutation?.body.op, 'move');
  assert.equal((mutation?.body as Record<string, unknown>).id, 'T-001');
  assert.equal((mutation?.body as Record<string, unknown>).toState, 'ready');
  view.unmount();
});

test('Alt+ArrowLeft at the first lane moves nothing and says so', async () => {
  const view = await mountBoard(loadBundle());
  await view.key('[data-card="T-001"]', 'ArrowLeft', { altKey: true });
  await flush();
  assert.equal(lastMutation(), undefined, 'no mutation for a move off the board');
  assert.match(view.text(), /already at the edge/);
  view.unmount();
});

test('a drag onto another lane sends one move with the target lane and an index', async () => {
  const view = await mountBoard(loadBundle());
  await view.drag('[data-card="T-003"]', '[data-lane="review"]', 5);
  await flush();
  const mutation = lastMutation();
  assert.equal(mutation?.body.op, 'move');
  assert.equal((mutation?.body as Record<string, unknown>).toState, 'review');
  assert.equal(typeof (mutation?.body as Record<string, unknown>).toPosition, 'number');
  view.unmount();
});

test('a drag the local gates refuse never reaches the host, and the reason is shown', async () => {
  const view = await mountBoard(loadBundle());
  // T-004 is in progress and the lane is at its limit of two, so a third card cannot be pulled in.
  await view.drag('[data-card="T-002"]', '[data-lane="in-progress"]', 5);
  await flush();
  assert.equal(lastMutation(), undefined, 'the panel refuses before spending a round trip');
  assert.match(view.text(), /limit is 2 and it is full/);
  view.unmount();
});

test('a host refusal rolls the card back and names what is missing', async () => {
  const payload = fixture();
  setFetch((call) => {
    if (call.url.includes('/board')) return { status: 200, body: { ok: true, board: payload, rev: payload.rev } };
    if (call.url.includes('/mutate')) {
      return {
        status: 422,
        body: { ok: false, code: 'dor-incomplete', message: 'cannot leave backlog: 1 check unticked', missing: ['estimate'] },
      };
    }
    return { status: 404, body: {} };
  });
  const view = mount(loadBundle(), loadBundle().slot('main'), { store: freshStore(loadBundle()) });
  await flush();

  await view.drag('[data-card="T-001"]', '[data-lane="ready"]', 5);
  await flush();

  assert.match(view.text(), /cannot leave backlog/);
  assert.match(view.text(), /missing: estimate/);
  // The rollback is the point: the card is back in the lane the host still believes it is in.
  const backlog = view.find('[data-lane="backlog"]');
  assert.equal(backlog?.querySelector('[data-card="T-001"]') !== null, true);
  const ready = view.find('[data-lane="ready"]');
  assert.equal(ready?.querySelector('[data-card="T-001"]') === null, true);
  view.unmount();
});

// ------------------------------------------------------------------ the drawer

test('clicking a card opens the drawer for it', async () => {
  const view = await mountBoard(loadBundle());
  assert.equal(view.has('[data-drawer]'), false);
  await view.click('[data-card="T-003"]');
  await flush();
  assert.equal(view.has('[data-drawer="T-003"]'), true);
  view.unmount();
});

test('the drawer carries both checklists, and a tick sends a check mutation', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-001"]');
  await flush();
  const drawer = view.find('[data-drawer="T-001"]');
  const text = drawer?.textContent ?? '';
  assert.match(text, /Definition of Ready/);
  assert.match(text, /Definition of Done/);

  // T-001's DoR is fully ticked, so the first checklist control unticks `outcome`.
  const control = view.find('[data-drawer="T-001"] button[aria-pressed="true"]');
  assert.ok(control !== null);
  await view.click('[data-drawer="T-001"] button[aria-pressed="true"]');
  await flush();
  const mutation = lastMutation();
  assert.equal(mutation?.body.op, 'check');
  assert.equal((mutation?.body as Record<string, unknown>).gate, 'dor');
  assert.equal((mutation?.body as Record<string, unknown>).done, false);
  view.unmount();
});

test('the drawer closes and the board stops filtering by that card', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-005"]');
  await flush();
  const close = [...view.findAll('[data-drawer="T-005"] button')].find((node) => node.textContent === 'Close');
  assert.ok(close !== undefined && close !== null);
  await view.click('[data-drawer="T-005"] button');
  await flush();
  assert.equal(view.has('[data-drawer]'), false);
  view.unmount();
});

test('the drawer asks the host for the card and records the request it made', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-004"]');
  await flush();
  assert.equal(
    recorded().some((call) => call.url.includes('/task/T-004')),
    true
  );
  view.unmount();
});

test('opening a card moves focus into the drawer, and Escape closes it back onto the card', async () => {
  const view = await mountBoard(loadBundle());
  // Put the keyboard on the card the way `Tab` would, then open it: the drawer must take focus
  // with it, or the next Tab walks the whole toolbar before reaching the checklists.
  await view.focus('[data-card="T-003"]');
  await view.click('[data-card="T-003"]');
  await flush();

  const opened = view.find('[data-drawer="T-003"]');
  assert.equal(document.activeElement, opened, 'the drawer itself receives focus when it opens');
  assert.equal(opened?.getAttribute('tabindex'), '-1', 'and it is programmatically focusable, not a tab stop');
  // Not a modal, and not a trap: the drawer holds focusable controls and Tab is never intercepted.
  assert.ok((opened?.querySelectorAll('button, input').length ?? 0) > 0, 'its controls are reachable');

  await view.focus('[data-drawer="T-003"]');
  await view.key('[data-drawer="T-003"]', 'Escape');
  await flush();

  assert.equal(view.has('[data-drawer]'), false, 'Escape closes the drawer');
  assert.equal(view.has('[data-card="T-003"]'), true, 'and the card is still on the board');
  assert.equal(document.activeElement, view.find('[data-card="T-003"]'), 'focus returns to the originating card');
  view.unmount();
});

test('keeping the drawer open, a refusal names what is missing', async () => {
  const payload = fixture();
  setFetch((call) => {
    if (call.url.includes('/board')) return { status: 200, body: { ok: true, board: payload, rev: payload.rev } };
    if (call.url.includes('/mutate')) {
      return {
        status: 422,
        body: { ok: false, code: 'dor-incomplete', message: 'cannot leave backlog: 1 check unticked', missing: ['estimate'] },
      };
    }
    if (call.url.includes('/task/')) return { status: 200, body: { ok: true, task: null, comments: [], events: [] } };
    return { status: 404, body: {} };
  });
  const view = mount(loadBundle(), loadBundle().slot('main'), { store: freshStore(loadBundle()) });
  await flush();

  // T-001 has a full DoR, so the panel moves it optimistically; the host refuses and rolls back.
  await view.click('[data-card="T-001"]');
  await flush();
  await view.click('[aria-label="Move T-001 to Ready"]');
  await flush();

  assert.equal(view.has('[data-drawer="T-001"]'), true, 'the drawer stays open while the refusal is shown');
  assert.equal(lastMutation()?.body.op, 'move', 'the refusal came from the host, not from a local gate');
  // The panel refusal strip is outside the drawer, so both must survive it: the reason names the
  // unticked check and the human keeps the card they were working on.
  assert.match(view.text(), /cannot leave backlog/);
  assert.match(view.text(), /missing: estimate/);
  view.unmount();
});

// ------------------------------------------------------------------ polling

test('mounting starts polling with a revision cursor, and unmounting stops it', async () => {
  const loaded = loadBundle();
  const store = freshStore(loaded) as { getSnapshot(): { payload: { rev: number } | null } };
  respondWithBoard(fixture());
  const view = mount(loaded, loaded.slot('main'), { store });
  await flush();

  const first = recorded().filter((call) => call.url.includes('/board'));
  assert.equal(first.length, 1, 'the first read has no cursor');
  assert.equal(first[0]?.url.includes('since='), false);
  assert.equal(store.getSnapshot().payload?.rev, 7);
  view.unmount();
});

test('a 304 leaves the snapshot object identical, so React is not asked to render', async () => {
  const loaded = loadBundle();
  const payload = fixture();
  let boardCalls = 0;
  setFetch((call) => {
    if (call.url.includes('/board')) {
      boardCalls += 1;
      return boardCalls === 1
        ? { status: 200, body: { ok: true, board: payload, rev: payload.rev } }
        : { status: 304, body: undefined };
    }
    return { status: 404, body: {} };
  });

  const store = freshStore(loaded) as { getSnapshot(): unknown; refresh(force?: boolean): Promise<void> };
  const view = mount(loaded, loaded.slot('main'), { store });
  await flush();
  assert.equal(boardCalls, 1);

  const before = store.getSnapshot();
  await store.refresh(false);
  await flush();

  // A defensive copy in `getSnapshot` once caused "Maximum update depth exceeded": the hook
  // compares snapshots by reference, so an unchanged board must be the *same object*.
  assert.equal(boardCalls, 2, 'the poll asked with its revision cursor');
  assert.equal(store.getSnapshot(), before, 'and the snapshot is untouched');
  view.unmount();
});

test('the active view button says so, and the count says how much is hidden', async () => {
  const payload = fixture();
  const view = await mountBoard(loadBundle(), {
    ...payload,
    views: [{ id: 'v-ready', name: 'Ready', description: 'ready and beyond', filter: READY_VIEW }],
  });

  const pressed = (): (string | null)[] =>
    view.findAll('nav[aria-label="Views"] .kb-btn[aria-pressed="true"]').map((node) => node.textContent);
  // Two controls are pressed with nothing filtered: `All`, which is the unfiltered board, and
  // `Dropped`, whose view is the only way to the state the board does not draw. They are not in
  // conflict — `All` is everything, `Dropped` is one state — and neither is a saved view.
  assert.deepEqual(pressed(), ['All'], 'with no filter, All is the current view and the saved view is not');
  assert.match(view.text(), /6 cards/);
  assert.equal(view.has('nav[aria-label="Views"]'), true, 'the switcher is one named control group');

  // The saved view is the only unpressed *view* button; `Dropped` is always present, so it is named
  // rather than counted, and the assertion above pins which buttons claim the current board.
  await view.click('nav[aria-label="Views"] button[title="ready and beyond"]');
  await flush();

  // A filtered board must be distinguishable from an unfiltered one, in the toolbar itself.
  assert.deepEqual(pressed(), ['Ready']);
  assert.match(view.text(), /showing 4 of 6 cards/);
  assert.equal(view.has('[data-card="T-001"]'), false, 'the backlog card is filtered out');
  assert.equal(view.has('[data-card="T-002"]'), true);
  assert.equal(view.has('[data-card="T-006"]'), false, 'and the dropped card is never on a filtered board');
  view.unmount();
});

test('the state chip row is gone, and the views are the panel filter', async () => {
  const view = await mountBoard(loadBundle(), { ...fixture(), views: SEEDED_VIEWS });
  // The row repeated what the lane headers already said. It is not hidden, it is absent.
  assert.equal(view.findAll('[data-state]').length, 0, 'no per-state chip row');
  assert.equal(view.find('[data-lane="review"] .kb-lane-name')?.textContent, 'Review', 'the lanes still name every state');
  assert.equal(view.has('[data-card="T-005"]'), true, 'the unfiltered board shows the finished card');

  await view.click('nav[aria-label="Views"] button[title="everything still moving"]');
  await flush();
  const board = view.find('nav[aria-label="Views"] button[title="everything still moving"]');
  assert.equal(board?.getAttribute('aria-pressed'), 'true', 'the view presses itself');
  assert.equal(view.has('[data-card="T-005"]'), false, 'Board filters the done lane out');
  assert.match(view.text(), /showing 4 of 6 cards/, 'and the header says how much is hidden');

  // `All` is the way back out. It is not redundant with the saved views: it is the only one that
  // shows `done`, so deleting it would put finished cards out of the panel's reach.
  await view.click('[data-action="all"]');
  await flush();
  assert.equal(view.find('[data-action="all"]')?.getAttribute('aria-pressed'), 'true');
  assert.equal(view.has('[data-card="T-005"]'), true, 'the finished card is back');
  view.unmount();
});

// ------------------------------------------------------------------ P1.1 the Dropped view

test('P1.1: the default board is still five lanes, and dropped is not one of them', async () => {
  // The invariant this pass must not break: the distill removed a sixth lane and it stays removed.
  // The dropped card in the fixture is in the store, the counts and the metrics and nowhere on the
  // default board — which is exactly why the view below has to exist.
  const view = await mountBoard(loadBundle());
  assert.deepEqual(
    view.findAll('[data-lane]').map((node) => node.getAttribute('data-lane')),
    ['backlog', 'ready', 'in-progress', 'review', 'done'],
    'five lanes, no sixth'
  );
  assert.equal(view.has('[data-card="T-006"]'), false, 'the dropped card is not drawn on the board');
  assert.equal(view.has('[data-action="dropped"]'), true, 'but the view that reaches it is');
  assert.equal(
    view.find('[data-action="dropped"]')?.getAttribute('aria-pressed'),
    'false',
    'the view exists without claiming the board'
  );
  assert.equal(view.find('[data-action="all"]')?.getAttribute('aria-pressed'), 'true', 'All still means unfiltered');
  view.unmount();
});

test('P1.1: the Dropped view draws the dropped lane and nothing else', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-action="dropped"]');
  await flush();

  assert.deepEqual(
    view.findAll('[data-lane]').map((node) => node.getAttribute('data-lane')),
    ['dropped'],
    'one lane, the one state the board otherwise refuses to draw'
  );
  assert.equal(view.has('[data-card="T-006"]'), true, 'the card that vanished is reachable');
  assert.equal(view.find('[data-card="T-006"]')?.className.includes('kb-card-dropped'), true, 'and marked as out of play');
  assert.equal(view.find('[data-action="dropped"]')?.getAttribute('aria-pressed'), 'true');
  assert.equal(view.find('[data-action="all"]')?.getAttribute('aria-pressed'), 'false', 'All is not claiming the board');
  assert.match(view.text(), /showing 1 of 6 cards/, 'the header says what is on screen');
  view.unmount();
});

test('P1.1: All stays the escape from the Dropped view, and the dropped card can be taken back', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-action="dropped"]');
  await flush();
  assert.deepEqual(view.findAll('[data-lane]').map((node) => node.getAttribute('data-lane')), ['dropped']);

  // `All` is untouched by this pass: the way back out of a view still works, and it is still the only
  // control that shows finished cards.
  await view.click('[data-action="all"]');
  await flush();
  assert.deepEqual(
    view.findAll('[data-lane]').map((node) => node.getAttribute('data-lane')),
    ['backlog', 'ready', 'in-progress', 'review', 'done']
  );
  assert.equal(view.has('[data-card="T-006"]'), false, 'and the dropped card is out of play again');

  // The way back *into* play: the card in the Dropped view is a real card, so opening it and moving it
  // through the panel's own move set returns it to the board. Reachability was the whole defect.
  await view.click('[data-action="dropped"]');
  await flush();
  await view.click('[data-card="T-006"]');
  await flush();
  assert.equal(view.has('[data-drawer="T-006"]'), true);
  await view.click('[data-drawer="T-006"] button[aria-label="Move T-006 to Backlog"]');
  await flush();
  const mutation = lastMutation();
  assert.equal(mutation?.body.toState, 'backlog', 'the move goes through the same route as any other');
  assert.equal(mutation?.body.id, 'T-006');
  assert.equal(mutation?.body.reason, undefined, 'and a reopen needs no reason; only a drop and a forced move do');
  view.unmount();
});

test('P1.1: Alt+←/→ on a dropped card says it is dropped, not that it is at an edge', async () => {
  // A dropped card is not at the edge of the board — it is not on the board at all, which is why the
  // keyboard target is null. Telling a reader it is "already at the edge" of a board that refuses to
  // draw it is a small lie, and the drawer's `→ Backlog` is the real answer.
  const view = await mountBoard(loadBundle());
  await view.click('[data-action="dropped"]');
  await flush();
  await view.focus('[data-card="T-006"]');
  await view.key('[data-card="T-006"]', 'ArrowRight', { altKey: true });
  await flush();
  assert.match(view.text(), /T-006 is dropped/);
  assert.equal(view.text().includes('edge of the board'), false, 'a dropped card is not at an edge');
  assert.equal(lastMutation(), undefined, 'and the panel did not invent a move to send to the host');
  view.unmount();
});

test('P1.1: only a filter that names dropped draws the dropped lane', () => {
  // The narrow rule, at the level where it is decided. `All` (the empty filter) keeps the board's five
  // lanes, a saved view that happens to include dropped still draws the board, and only an explicit
  // `['dropped']` — the panel's own view — swaps the lanes. That is what keeps this from becoming a
  // sixth lane by the back door.
  assert.deepEqual(filterStates(EMPTY_FILTER), ['backlog', 'ready', 'in-progress', 'review', 'done']);
  assert.deepEqual(filterStates(DROPPED_FILTER), ['dropped']);
  assert.deepEqual(filterStates({ state: ['dropped'], priority: ['p0-critical'] }), ['dropped'], 'a saved filter that names dropped is still a dropped filter');
  assert.deepEqual(filterStates({ state: ['dropped', 'done'] }), ['backlog', 'ready', 'in-progress', 'review', 'done'], 'dropped alongside another state is the board, as it always was');
  assert.deepEqual(filterStates({ search: 'x' }), ['backlog', 'ready', 'in-progress', 'review', 'done']);
  // And the drawn columns follow the same rule, so the promise holds where it is rendered.
  const payload = boardPayload() as unknown as Parameters<typeof columnsOf>[0];
  assert.deepEqual(columnsOf(payload, EMPTY_FILTER).map((column) => column.state), ['backlog', 'ready', 'in-progress', 'review', 'done']);
  assert.deepEqual(columnsOf(payload, DROPPED_FILTER).map((column) => column.state), ['dropped']);
});

// ------------------------------------------------------------------ P1.2 the drawer's ring

test('P1.2: a drawer opened from the keyboard claims its ring, a pointer-opened one does not', async () => {
  // The defect: the drawer is focused programmatically, `:focus-visible` is not guaranteed for a
  // script-driven focus, and a keyboard user could open a card and see no indication of where they
  // were. The fix is a claim in the DOM, read once at mount, plus the ring rule keyed on it.
  const view = await mountBoard(loadBundle());

  await view.focus('[data-card="T-002"]');
  await view.key('[data-card="T-002"]', 'Enter');
  await flush();
  assert.equal(view.has('[data-drawer="T-002"]'), true);
  assert.equal(
    view.find('[data-drawer="T-002"]')?.getAttribute('data-open'),
    'keyboard',
    'Enter on a card moved the keyboard into the drawer, so the drawer shows it'
  );
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  assert.match(styles, /\.kb-drawer\[data-open="keyboard"\]:focus \{[^}]*outline: 2px solid var\(--dsw-alias-brand-primary/);

  await view.unmount();

  // The pointer path stays quiet: a click is not a claim about the keyboard's place.
  const clicked = await mountBoard(loadBundle());
  await clicked.click('[data-card="T-003"]');
  await flush();
  assert.equal(clicked.find('[data-drawer="T-003"]')?.getAttribute('data-open'), 'pointer');
  clicked.unmount();
});

test('P1.2: a click on a second card does not inherit the first drawer’s keyboard claim', async () => {
  // The leak: the click handler kept the claim whenever *a* drawer held focus, but a click on another
  // card replaces that drawer with a new keyed one -- which then re-read the flag and painted a
  // pointer-opened drawer with the keyboard ring. Enter-open T-002, then click T-003: T-003's drawer
  // is a pointer path and must say so.
  const view = await mountBoard(loadBundle());

  await view.focus('[data-card="T-002"]');
  await view.key('[data-card="T-002"]', 'Enter');
  await flush();
  assert.equal(view.find('[data-drawer="T-002"]')?.getAttribute('data-open'), 'keyboard');
  // The keyboard claim is only interesting because that drawer really is holding focus: if the focus
  // never landed there, the old guard would have cleared the flag for a different reason and this
  // case would pass against the bug.
  assert.equal((view.container.ownerDocument.activeElement as Element | null)?.className, 'kb-drawer');

  await view.click('[data-card="T-003"]');
  await flush();
  assert.equal(view.has('[data-drawer="T-002"]'), false, 'the keyed drawer was replaced, not reused');
  assert.equal(
    view.find('[data-drawer="T-003"]')?.getAttribute('data-open'),
    'pointer',
    'a click is a pointer path, whatever the drawer it replaced was doing'
  );
  view.unmount();
});

// ------------------------------------------------------------------ P2.3 loading is a state

/**
 * A reply the transport will wait for, then read.
 *
 * The harness's fake `fetch` awaits the handler's return value, so a handler that returns a promise
 * settles to `undefined` and looks like a failure. This is a **thenable that never resolves** and
 * carries the reply's own fields (`status`, `ok`, `text`), which is exactly how "the host has not
 * spoken yet" looks from inside `createHttpTransport`: the status is read synchronously, the body is
 * awaited forever.
 */
function neverAnsweringReply(status = 200): Promise<never> {
  return Object.assign(new Promise<never>(() => {}), {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify({ ok: false }),
  });
}

test('P2.3: a first load in flight is a state on the board, not only a sentence in the header', async () => {
  const loaded = loadBundle();
  // A read that never answers: the request is genuinely in flight, which is what `loading` means.
  setFetch((() => neverAnsweringReply()) as never);
  const view = mount(loaded, loaded.slot('main'), { store: freshStore(loaded) });
  await flush();

  assert.match(view.text(), /connecting…/, 'the header still says it in words');
  const lanes = view.find('.kb-lanes');
  assert.equal(lanes?.getAttribute('aria-busy'), 'true', 'and the board says so to a reader');
  assert.equal(lanes?.className.includes('kb-lanes-loading'), true);
  assert.equal(view.findAll('.kb-skeleton').length > 0, true, 'the lanes show a pending line, not a verdict');
  assert.equal(view.has('.kb-empty'), false, 'and not "nothing here", which would be a claim');
  view.unmount();
});

test('P2.3: a pending lane prints no limit it cannot know', async () => {
  // The Definition of Workflow arrives with the payload, so while the first read is in flight there is
  // no honest limit to print. `pendingColumns` used to build its lanes from `DEFAULT_DOW`, which could
  // contradict the board it was standing in for: a lane headed `0/2` over a board whose real WIP limit
  // is 9. The lane's name and its `0` are enough until the payload says otherwise.
  const loaded = loadBundle();
  setFetch((() => neverAnsweringReply()) as never);
  const view = mount(loaded, loaded.slot('main'), { store: freshStore(loaded) });
  await flush();
  assert.deepEqual(
    view.findAll('[data-lane]').map((node) => node.getAttribute('data-lane')),
    ['backlog', 'ready', 'in-progress', 'review', 'done'],
    "the pending board draws the board's own five lanes"
  );
  assert.deepEqual(
    view.findAll('.kb-lane-count').map((node) => node.textContent),
    ['0', '0', '0', '0', '0'],
    'and no lane prints a cap it has not been told'
  );
  view.unmount();
});

test('P2.3: a write in flight marks the board busy, and the mark follows the store', async () => {
  const loaded = loadBundle();
  // The busy half is injected rather than raced: the panel's only job here is to render the store's
  // own `busy`, and a poll landing mid-write (a real store behaviour, pinned by the case below) would
  // make a click-then-assert test flaky for a reason that has nothing to do with the render.
  const snapshot = {
    status: 'ready',
    payload: boardPayload(),
    filter: {},
    selectedId: null,
    detail: null,
    notice: null,
    origin: { origin: 'http://localhost', source: 'test', detail: '', document: { protocol: 'http:', origin: 'http://localhost', baseURI: 'http://localhost/' } },
    busy: true,
    lastError: null,
  };
  const busyStore = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    start: () => () => {},
    refresh: async () => {},
    setFilter: () => {},
    select: async () => {},
    notice: () => {},
    create: async () => {},
    move: async () => {},
    tick: async () => {},
    patch: async () => {},
    comment: async () => {},
    block: async () => {},
    unblock: async () => {},
    drop: async () => {},
    purge: async () => {},
  };
  const view = mount(loaded, loaded.slot('main'), { store: busyStore });
  await flush();
  const lanes = view.find('.kb-lanes');
  assert.equal(lanes?.getAttribute('aria-busy'), 'true', 'a write in flight marks the board');
  assert.equal(lanes?.className.includes('kb-lanes-busy'), true, 'and says which pending state it is');
  assert.equal(lanes?.className.includes('kb-lanes-loading'), false, 'a write is not a first load');
  assert.match(view.text(), /rev 7/, 'the board behind the write is still drawn');
  view.unmount();

  // And the quiet case, as a contrast: no busy, no mark.
  const settled = await mountBoard(loadBundle());
  assert.equal(settled.find('.kb-lanes')?.getAttribute('aria-busy'), 'false');
  settled.unmount();
});

test('P2.3: a write sets the store’s busy flag and a settled write clears it', async () => {
  // The half of the pending state the panel does not own: the store's own flag. It is asserted here
  // rather than through a click because the store's poll runs on a timer and would race a rendered
  // assertion — and because when this pass began, a poll landing mid-write *did* clear `busy`, so the
  // two halves of "in flight" are worth keeping separate and honest.
  const transport = {
    origin: { origin: 'http://localhost', source: 'test', detail: '', document: { protocol: 'http:', origin: 'http://localhost', baseURI: 'http://localhost/' } },
    board: async () => ({ changed: true, payload: boardPayload() as never }),
    task: async () => ({ task: null, comments: [], events: [] }) as never,
    mutate: async () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ rev: 8, result: {} }), 60);
      }),
    health: async () => ({}),
  };
  const store = createBoardStore(transport as never, { pollMs: 600_000 });
  store.start();
  await flush();
  const pending = store.create('a card that waits');
  assert.equal(store.getSnapshot().busy, true, 'a write sets the mark before it awaits the host');
  await pending;
  assert.equal(store.getSnapshot().busy, false, 'and clears it when the host answers');
});

test('P2.3: a poll that lands mid-write ends neither the busy mark nor the optimistic card', async () => {
  // The race the two cases above keep apart, run deliberately. A write is in flight and the timer's
  // own read answers before the host has spoken; that read is not the write's answer, so it must not
  // clear `busy` — which switches the `kb-lanes-busy` treatment off early — and must not put the
  // polled board back over the optimistic payload, which is how a card the human just moved snaps
  // back. The polled answer carries a **changed** board (an external writer moved the revision on)
  // with T-003 still where the human found it: that external change is what makes the payload half
  // bite, while the `busy` half needs no second writer at all.
  const initial = boardPayload();
  // Where the poll finds the board: another writer moved `rev` on, and T-003 is still in progress.
  const polled = boardPayload({ rev: 8, title: 'Board, moved elsewhere' });
  // Where the write's own read finds it: T-003 in review, which is where the optimistic move put it.
  const settled = boardPayload({
    rev: 8,
    tasks: (initial.tasks as Record<string, unknown>[]).map((task) =>
      task.id === 'T-003' ? { ...task, state: 'review', position: 0 } : task
    ),
  });
  let serverBoard = initial;
  let settleMutation: (outcome: unknown) => void = () => {};
  const mutation = new Promise((resolve) => {
    settleMutation = resolve;
  });
  const transport = {
    origin: { origin: 'http://localhost', source: 'test', detail: '', document: { protocol: 'http:', origin: 'http://localhost', baseURI: 'http://localhost/' } },
    board: async () => ({ changed: true, payload: serverBoard as never }),
    task: async () => ({ task: null, comments: [], events: [] }) as never,
    mutate: async () => mutation as never,
    health: async () => ({}),
  };
  const store = createBoardStore(transport as never);
  const stateOf = (id: string): string | undefined =>
    store.getSnapshot().payload?.tasks.find((task) => task.id === id)?.state;

  await store.refresh(true); // the first payload, with T-003 in progress
  assert.equal(store.getSnapshot().busy, false);

  serverBoard = polled; // the timer's read will answer with a changed board
  const move = store.move('T-003', 'review');
  assert.equal(store.getSnapshot().busy, true, 'a write sets the mark before it awaits the host');
  assert.equal(stateOf('T-003'), 'review', 'and the card lands in review optimistically');

  // The timer's own path — `refresh(false)` — answered while `transport.mutate` is still in flight.
  await store.refresh(false);
  assert.equal(store.getSnapshot().busy, true, 'a poll mid-write must not end the write’s busy mark');
  assert.equal(stateOf('T-003'), 'review', 'nor put the polled board over the optimistic card');

  serverBoard = settled; // the host has answered; the write's own read now finds the truth
  settleMutation({ rev: 8, result: {} });
  await move;
  assert.equal(store.getSnapshot().busy, false, 'the write’s own read ends the mark');
  assert.equal(stateOf('T-003'), 'review', 'and the stored board is the host’s');
});

// ------------------------------------------------------------------ P2.4 error is a state

test('P2.4: an unreachable board is a state with a recovery, not only a sentence', async () => {
  const loaded = loadBundle();
  let boardReads = 0;
  let failing = true;
  setFetch((call) => {
    if (call.url.includes('/board')) {
      boardReads += 1;
      if (failing) throw new Error('network down');
      return { status: 200, body: { ok: true, board: boardPayload(), rev: 7 } };
    }
    return { status: 200, body: { ok: true, result: {} } };
  });
  const view = mount(loaded, loaded.slot('main'), { store: freshStore(loaded) });
  await flush();

  const notice = view.find('.kb-notice-error');
  assert.ok(notice !== null, 'the failure is on screen');
  assert.equal(notice.getAttribute('role'), 'status', 'and it is a state a reader is told about');
  assert.equal(notice.getAttribute('aria-live'), 'polite');
  assert.match(notice.textContent ?? '', /board unavailable/);
  assert.equal(view.find('[data-action="retry-board"]')?.textContent, 'Retry', 'the recovery names itself');
  assert.equal(view.has('.kb-lanes'), false, 'a board that could not be read is not drawn as an empty one');

  const before = boardReads;
  failing = false;
  await view.click('[data-action="retry-board"]');
  await flush();
  assert.ok(boardReads > before, 'Retry asks the host again');
  assert.equal(view.has('.kb-lanes'), true, 'and the board arrives');
  assert.equal(view.has('.kb-notice-error'), false);
  view.unmount();
});

// ------------------------------------------------------------------ P2.5 disabled

test('P2.5: a disabled control reads as disabled, and never keeps a chosen look', async () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  // The only opacity in the sheet is the disabled one, and it is stated for the button that is both
  // pressed and disabled -- a ticked checklist row a mutation has just taken out of action.
  assert.match(styles, /\.kb-btn:disabled \{ opacity: 0\.5; cursor: default; \}/);
  assert.match(styles, /\.kb-btn\[aria-pressed="true"\]:disabled \{ background: transparent; border-color: var\(--dsw-alias-border-l1/);
  assert.equal(styles.includes('opacity: 0.4'), false, 'no second opacity was invented');

  const view = await mountBoard(loadBundle());
  // The create button is the panel's always-present disabled control: it is disabled until the title
  // has content, and it says so as an attribute rather than as a colour.
  assert.equal(view.find('[data-action="create"]')?.hasAttribute('disabled'), true);
  assert.equal(view.find('[data-action="create"]')?.getAttribute('aria-pressed'), null);
  await view.type('input[aria-label="New card title"]', 'x');
  assert.equal(view.find('[data-action="create"]')?.hasAttribute('disabled'), false);
  view.unmount();

  // The state the stylesheet rule above exists for, rendered rather than assumed: a ticked checklist
  // row while its own mutation is in flight. The row is `aria-pressed="true"` (T-001's DoR is ticked)
  // and the store's `busy` disables it, so the panel really does produce the pressed+disabled
  // combination -- before this, no component did and the rule was dead while the claim about it stood.
  const loaded = loadBundle();
  respondWithBoard(fixture());
  const store = freshStore(loaded) as {
    tick(id: string, gate: 'dor' | 'dod', checkId: string, done: boolean): Promise<void>;
  };
  const ticking = mount(loaded, loaded.slot('main'), { store });
  await flush();
  await ticking.click('[data-card="T-001"]');
  await flush();
  const row = (): Element | null => ticking.find('[data-drawer="T-001"] .kb-check');
  assert.equal(row()?.getAttribute('aria-pressed'), 'true', 'the ticked DoR row is the chosen control');
  assert.equal(row()?.hasAttribute('disabled'), false, 'and it is live while nothing is in flight');
  // `write` sets `busy` synchronously, so the row can be read while the host has not answered yet.
  const inFlight = store.tick('T-001', 'dor', 'outcome', false);
  ticking.rerender({ store });
  assert.equal(row()?.getAttribute('aria-pressed'), 'true', 'the row keeps its chosen state');
  assert.equal(row()?.hasAttribute('disabled'), true, 'while the tick cannot land');
  await inFlight;
  await flush();
  assert.equal(row()?.hasAttribute('disabled'), false, 'and it is live again once the host has answered');
  ticking.unmount();
});

test('P1.1: the drawer of a dropped card offers the way back, not only Close', async () => {
  // The defect the view exposed: a dropped card's state is not in `BOARD_STATES`, so "the next lane"
  // was null and the drawer rendered no primary move at all. A view that shows a card you cannot move
  // is a view that shows a dead end.
  const view = await mountBoard(loadBundle());
  await view.click('[data-action="dropped"]');
  await flush();
  await view.click('[data-card="T-006"]');
  await flush();
  const drawer = view.find('[data-drawer="T-006"]');
  assert.ok(drawer !== null);
  assert.equal(drawer.querySelector('button[aria-label="Move T-006 to Backlog"]') !== null, true, 'the first lane is the way back');
  assert.match(drawer.textContent ?? '', /→ Backlog/);
  view.unmount();
});

// ------------------------------------------------------------------ P3/P4 stylesheet invariants

test('P3.6: one fallback alpha per role, declared once, and no rule invents a fifth', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  const sheet = styles.slice(styles.indexOf('export const STYLES'));

  // A literal used more than once is a role, and a role has one value: the three that had drifted are
  // declared together, once, next to the radii and the measure.
  assert.match(sheet, /--kb-border-l1: rgba\(128,128,128,0\.35\)/);
  assert.match(sheet, /--kb-bg-layer-2: rgba\(128,128,128,0\.12\)/);
  assert.match(sheet, /--kb-label-secondary: rgba\(128,128,128,0\.9\)/);
  assert.equal((sheet.match(/--kb-border-l1:/g) ?? []).length, 1, 'declared once');
  assert.equal((sheet.match(/--kb-bg-layer-2:/g) ?? []).length, 1);
  assert.equal((sheet.match(/--kb-label-secondary:/g) ?? []).length, 1);

  // The drift itself, as a rule rather than as a diff: every rule that needs one of the three role
  // literals now takes the declared property, so there is no direct `var(--dsw-alias-…, rgba(…))`
  // fallback left to drift to a fifth alpha. `var(--dsw-alias-border-l1, …)` sitting inside the
  // nested `border-l2` chain is a different role's deliberate stronger step, not a second alpha for
  // this one, so the text before the match decides it. Counting first keeps the failure message
  // small — a deep-equal on a match array would print the whole stylesheet.
  const alphas = (token: string): string[] =>
    [...sheet.matchAll(new RegExp(`var\\(${token}, rgba\\(128,128,128,([0-9.]+)\\)\\)`, 'g'))]
      .filter((match) => !(sheet.slice(Math.max(0, (match.index ?? 0) - 32), match.index) + match[0]).includes('--dsw-alias-border-l2, var(--dsw-alias-border-l1'))
      .map((match) => match[1] as string);
  assert.deepEqual(alphas('--dsw-alias-border-l1'), [], 'border-l1 takes --kb-border-l1, never its own literal');
  assert.deepEqual(alphas('--dsw-alias-bg-layer-2'), []);
  assert.deepEqual(alphas('--dsw-alias-label-secondary'), []);
  // And the property form is the one the rules actually use, so the walk above is not vacuous.
  for (const pair of [
    'var(--dsw-alias-border-l1, var(--kb-border-l1))',
    'var(--dsw-alias-bg-layer-2, var(--kb-bg-layer-2))',
    'var(--dsw-alias-label-secondary, var(--kb-label-secondary))',
  ]) {
    assert.equal(sheet.includes(pair), true, `${pair} is used`);
  }
  // The one deliberate exception: `border-l2` states its own stronger step inside the nested chain.
  assert.equal(sheet.includes('var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, rgba(128,128,128,0.5)))'), true);
});

test('P3.8: pressed and open share one treatment, and the open state carries a shape as well', async () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  // One vocabulary for the two states, and the caret is what distinguishes them without colour.
  assert.match(styles, /\.kb-btn\[aria-pressed="true"\], \.kb-more\[aria-expanded="true"\] \{[^}]*font-weight: 600/);
  assert.match(styles, /\.kb-more\[aria-expanded="true"\] \.kb-more-caret \{ transform: rotate\(90deg\); \}/);

  const view = await mountBoard(loadBundle(), { ...fixture(), views: SEEDED_VIEWS });
  // Both kinds are on screen, and both say their state in an attribute rather than in a colour.
  const toggle = view.find('[data-action="all"]');
  assert.equal(toggle?.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle?.getAttribute('aria-expanded'), null, 'a toggle presses');
  const disclosure = view.find('[data-action="more-host"]');
  assert.equal(disclosure?.getAttribute('aria-expanded'), 'false');
  assert.equal(disclosure?.getAttribute('aria-pressed'), null, 'a disclosure expands');
  assert.equal(disclosure?.querySelector('svg.kb-more-caret') !== null, true, 'and it is drawn with a caret');

  await view.click('[data-action="more-host"]');
  await flush();
  assert.equal(view.find('[data-action="more-host"]')?.getAttribute('aria-expanded'), 'true');
  assert.equal(view.find('[data-action="more-host"]')?.textContent, 'Host', 'the label never renames itself');
  view.unmount();
});

test('P3.10: the disclosure toggle is at least as tall as a button', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  // The floor is shared, so the smallest control by type is not the smallest by target. 3px + 13px x
  // 1.4 + 3px + 2px of border is 24px, which is the number in the rule.
  assert.match(styles, /\.kb-btn \{[^}]*min-height: 24px/);
  assert.match(styles, /\.kb-more \{ display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; font-size: 12px; \}/);
  assert.match(styles, /\.kb-more-caret \{ flex: 0 0 auto/);
});

test('P4.11: every kb- class the panel emits is authored in the sheet, and the families are rendered', async () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/client/components.ts', import.meta.url), 'utf8');
  const sheet = styles.slice(styles.indexOf('export const STYLES'));
  // The three template families, expanded to the members the panel can build: `kb-pri-*` slices the
  // store's own priority id to its code (exactly what `CardView` does), `kb-age-*` is the three age
  // bands, `kb-notice-*` is the three notice kinds.
  const families: Readonly<Record<string, readonly string[]>> = {
    'kb-pri-': PRIORITIES.map((priority) => `kb-pri-${priority.slice(0, 2)}`),
    'kb-age-': ['fresh', 'ageing', 'stale'].map((band) => `kb-age-${band}`),
    'kb-notice-': ['refusal', 'info', 'error'].map((kind) => `kb-notice-${kind}`),
  };
  // The walk this test's name always claimed but never did: every `kb-` token the components file
  // names is one it emits, because the class lists are its own string literals and template prefixes.
  // A trailing dash is one of the three families above and is expanded to its members.
  const emitted = new Set<string>();
  for (const match of source.matchAll(/kb-[a-z0-9-]+/g)) {
    const token = match[0] as string;
    if (token.endsWith('-')) for (const member of families[token] ?? []) emitted.add(member);
    else emitted.add(token);
  }
  assert.equal(emitted.size > 40, true, 'the walk found the panel classes, not an empty set');
  // A class is authored when a rule selects it. This is the half that would have caught the dead
  // `kb-lane-loading` push and the bare `kb-age` hook, and it fails the moment either comes back.
  const unstyled = [...emitted].filter((token) => !new RegExp(`\\.${token}(?![a-zA-Z0-9_-])`).test(sheet));
  assert.deepEqual(unstyled, [], 'these classes are emitted by components.ts and styled by nothing');
  // And the resting tiers are stated, not left to inheritance: that is what makes the families a
  // checkable set rather than a matter of restraint.
  assert.match(sheet, /\.kb-age-fresh \{ color: var\(--dsw-alias-label-secondary/);
  assert.match(sheet, /\.kb-pri-p4 \{ color: var\(--dsw-alias-label-primary/);

  // The rendered half: every card carries exactly one priority class and one age class, and the two
  // states that are easy to leave unstyled (a fresh age, a low priority) are on screen to be styled.
  const view = await mountBoard(loadBundle());
  const cards = view.findAll('[data-card]');
  assert.ok(cards.length > 0);
  for (const card of cards) {
    const priority = card.querySelector('.kb-pri');
    const age = card.querySelector('.kb-age-stale, .kb-age-ageing, .kb-age-fresh');
    assert.ok(priority !== null && age !== null, 'every card carries a priority code and an age band');
    assert.equal(
      PRIORITIES.filter((entry) => priority.className.includes(`kb-pri-${entry.slice(0, 2)}`)).length,
      1,
      `one priority class on ${String(card.getAttribute('data-card'))}`
    );
    assert.equal(
      ['fresh', 'ageing', 'stale'].filter((band) => age.className.includes(`kb-age-${band}`)).length,
      1,
      `one age band on ${String(card.getAttribute('data-card'))}`
    );
  }
  assert.equal(view.find('.kb-age-fresh') !== null, true, 'a fresh age is rendered and styled');
  assert.equal(view.find('.kb-pri-p2') !== null, true, 'so is the store default priority');
  view.unmount();
});

test('P4.12: the browser surfaces are themed from the app tokens, each keeping its fallback', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  assert.match(styles, /\.kb-page ::selection \{ background: var\(--dsw-alias-bg-document-selection, [^)]+\)/);
  assert.match(styles, /\.kb-page \{ caret-color: var\(--dsw-alias-label-primary, inherit\)/);
  assert.match(styles, /\.kb-lanes, \.kb-drawer \{ scrollbar-width: thin;/);
  assert.match(styles, /scrollbar-color: var\(--dsw-alias-scrollbar-bg-l1, var\(--kb-label-secondary\)\) var\(--dsw-alias-scrollbar-bg-l2, transparent\)/);
  assert.match(styles, /::-webkit-scrollbar-thumb \{[^}]*background: var\(--dsw-alias-scrollbar-bg-l1/);
  assert.match(styles, /::-webkit-scrollbar-thumb:hover \{[^}]*background: var\(--dsw-alias-scrollbar-hover-l1/);
});

test('P4.13: the motion budget is stated in the sheet and cancelled under reduced motion', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  assert.match(styles, /One authored motion moment, stated deliberately/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.kb-btn, \.kb-input, \.kb-card \{ transition: none; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.kb-more-caret \{ transition: none; \}/);
  assert.equal(styles.includes('@keyframes'), false, 'no keyframe was added to make polish visible');
  assert.equal(styles.includes('animation:'), false, 'and no animation');
});

// ------------------------------------------------------------------ model helpers

test('sameFilter ignores the order of a filter array, and nothing else', () => {
  // The arrays a filter carries are sets. `['done','ready']` and `['ready','done']` are the same
  // question, and comparing them verbatim is what left a saved view's button unpressed.
  assert.equal(sameFilter({ state: ['done', 'ready'] }, { state: ['ready', 'done'] }), true);
  assert.equal(sameFilter({ priority: ['p3-low', 'p0-critical'] }, { priority: ['p0-critical', 'p3-low'] }), true);
  assert.equal(sameFilter({ state: ['done', 'ready'], priority: ['p1-high', 'p2-normal'] }, { priority: ['p2-normal', 'p1-high'], state: ['ready', 'done'] }), true);
  // Order-insensitivity must not collapse genuinely different filters.
  assert.equal(sameFilter({ state: ['done', 'ready'] }, { state: ['done'] }), false, 'a different set is different');
  assert.equal(sameFilter({ state: ['done'] }, { state: ['done', 'done'] }), false, 'a multiset is not a set');
  assert.equal(sameFilter({ state: ['done', 'ready'] }, { state: ['done', 'ready'], blocked: true }), false);
  assert.equal(sameFilter({ search: 'x' }, { search: 'y' }), false);
  assert.equal(sameFilter({ sprintId: null }, { sprintId: 's-1' }), false, 'null is a question, not an absence');
  assert.equal(sameFilter({}, { blocked: undefined }), true, 'an undefined field is no field');
});

test('a forced move to the same state still needs its reason, as the host requires', () => {
  // `policy.checkMove` validates the exception's reason *before* it returns pass on a same-state move,
  // and the local pre-check now does the same. It used to wave the forced same-state move through,
  // which was one more way the two orders differed; this pins the order that remains.
  const payload = boardPayload() as unknown as Parameters<typeof checkMoveLocally>[0]['payload'];
  const task = (payload.tasks as readonly Parameters<typeof checkMoveLocally>[0]['task'][]).find(
    (entry) => entry.id === 'T-003'
  );
  assert.ok(task !== undefined);
  assert.deepEqual(checkMoveLocally({ payload, task, toState: 'in-progress' }), { ok: true }, 'same state is a no-op');
  const forced = checkMoveLocally({ payload, task, toState: 'in-progress', force: true });
  assert.equal(forced.ok, false, 'but an exception still owes a written reason');
});

test('a saved view stays pressed when the same states are chosen in another order', async () => {
  // Two views asking the same question with their arrays in a different order. `sameFilter`
  // canonicalises, so choosing one reads both as pressed; before it sorted the arrays, neither
  // matched and the toolbar highlighted nothing. (The chip row that used to build the other order
  // by hand is gone, so the two views now stand in for it.)
  const view = await mountBoard(loadBundle(), {
    ...fixture(),
    views: [
      { id: 'v-rev', name: 'Reverse', description: 'done and ready, listed the other way', filter: { state: ['done', 'ready'] } },
      { id: 'v-fwd', name: 'Forward', description: 'ready and done, listed the other way round', filter: { state: ['ready', 'done'] } },
    ],
  });

  await view.click('nav[aria-label="Views"] button[title="done and ready, listed the other way"]');
  await flush();

  const pressed = view.findAll('nav[aria-label="Views"] .kb-btn[aria-pressed="true"]').map((node) => node.textContent);
  assert.deepEqual(pressed, ['Reverse', 'Forward'], 'the same set of states, whatever order it was written in');
  view.unmount();
});

test('the stylesheet is injected once under its id, and removed with the panel', async () => {
  const first = await mountBoard(loadBundle());
  const styleId = 'dsh-kanban-styles';
  assert.equal(document.querySelectorAll(`style#${styleId}`).length, 1, 'one sheet, not one per render');

  // Re-render (as a poll does) and the sheet is still one node: it is not part of the element tree.
  first.rerender({});
  await flush();
  assert.equal(document.querySelectorAll(`style#${styleId}`).length, 1);

  first.unmount();
  assert.equal(document.querySelectorAll(`style#${styleId}`).length, 0, 'unmounting takes its sheet with it');

  // Every later mount re-injects it, so removing the first never leaves the board unstyled.
  const second = await mountBoard(loadBundle());
  assert.equal(document.querySelectorAll(`style#${styleId}`).length, 1);
  second.unmount();
});

/**
 * Every one-sided border declaration whose width is neither `0` nor exactly `1px`.
 *
 * The ban is on the "side-tab" tell — a thick stripe down one edge — and here the source text **is**
 * the contract: what is forbidden is *authoring* the declaration, whether or not it later wins the
 * cascade. The first version, `(?!0|1(?:px)?\b)\d`, let `1.5px` through because `1\b` matches
 * between the `1` and the `.`; this one anchors the value instead.
 */
function oneSidedBorderWidths(styles: string): string[] {
  return [...styles.matchAll(/border-(?:left|right)(?:-width)?:\s*([^;\n}]+)/g)]
    .map((match) => (match[1] ?? '').trim())
    .filter((value) => !/^(?:0|1px)(?![\d.])/.test(value));
}

/**
 * Every `body[data-ds-dark-theme]` rule, once its selector list is proved well-formed.
 *
 * A comment inside a selector list is not a comment to a CSS parser: the dangling selector before it
 * chains onto the next one, so `body[data-ds-dark-theme] <comment> body[data-ds-dark-theme] .kb-sub`
 * parses as the descendant selector `body[data-ds-dark-theme] body[data-ds-dark-theme] .kb-sub`,
 * which matches nothing. That is how the dark block shipped dead, and the old positive assertion —
 * a literal search for the marker — stayed green over it. This parses the list and rejects both the
 * comment that splits it and the chained marker it produces.
 */
function darkScopedRules(styles: string): string[] {
  const marker = 'body[data-ds-dark-theme]';
  const rules = [...styles.matchAll(/[^{}]+\{[^{}]*\}/g)].map((match) => match[0]);
  const dark = rules.filter((rule) => rule.slice(0, rule.indexOf('{')).includes(marker));
  for (const rule of dark) {
    const raw = rule.slice(0, rule.indexOf('{'));
    // A legitimate comment may *precede* a rule; only a comment after the first marker sits inside
    // the selector list. Starting at the marker is what tells those two apart without a CSS parser.
    const list = raw.slice(raw.indexOf(marker));
    assert.equal(
      list.includes('/*'),
      false,
      `a comment inside a dark selector list chains it onto the next selector: ${list.trim()}`
    );
    for (const selector of list.split(',')) {
      const trimmed = selector.trim();
      assert.equal(trimmed.startsWith(`${marker} `), true, `a dark selector must scope from the body marker: ${trimmed}`);
      assert.equal(trimmed.split(marker).length, 2, `a dark selector may name the marker once, not chain it: ${trimmed}`);
    }
  }
  return dark;
}

test('no craft-floor side stripe survives in the stylesheet', () => {
  // The detector flagged `border-left-width: 3px` on the notice strip as the "side-tab" tell. The
  // state signal those stripes carried is now a 1px border in the state colour, next to content
  // that already names the state — so this is a ban on re-adding the stripe, not on the colour.
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  assert.deepEqual(oneSidedBorderWidths(styles), [], 'no thick one-sided border');
  assert.match(styles, /\.kb-notice-refusal \{ border-color: var\(--dsw-alias-state-error-primary/);
  assert.match(styles, /\.kb-card-expedite \{ border-color: var\(--dsw-alias-state-error-primary/);
  assert.match(styles, /\.kb-card-blocked \{ border-color: var\(--dsw-alias-state-warn-primary/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/, 'the motion added is switchable off');
});

test('the side-stripe detector rejects 1.5px, which the old regex let through', () => {
  // The detector has to be able to fail: `1.5px` slipped past `(?!0|1(?:px)?\b)\d`. Both directions
  // of the tightened rule are pinned here, so a future loosening fails a named case.
  assert.deepEqual(oneSidedBorderWidths('border-left: 3px solid red; border-right-width: 1.5px;'), ['3px solid red', '1.5px']);
  assert.deepEqual(oneSidedBorderWidths('border-left: 0.5px; border-right: 2rem;'), ['0.5px', '2rem']);
  assert.deepEqual(oneSidedBorderWidths('border-left: 0; border-left: 1px solid var(--x, #333);'), []);
});

test('a partly-read board says so on screen', async () => {
  const payload = fixture();
  const view = await mountBoard(loadBundle(), { ...payload, truncated: { shown: 5, total: 900 } });
  assert.match(view.text(), /showing 5 of 900 cards/);
  view.unmount();
});

test('every CSS variable the panel uses is a theme token the app actually provides', () => {
  // The panel referenced ten invented `--dsh-color-*` names that resolve to nothing in this app.
  // Every one had a hard-coded grey fallback, so nothing looked broken enough to notice — the panel
  // was simply off-theme in both light and dark, and the variables were dead letters. No test could
  // see it and no browser was needed to find it: only this diff.
  //
  // Source of truth: `cordis_inspect_query platform=client provider=Theme method=listTokens` against
  // the running app, 2026-10-16 — fourteen tokens, all `--dsw-*`. Re-run that and update this list
  // when the app's theme changes.
  //
  // `--dsw-alias-label-tertiary` was added from the app's own compiled stylesheet
  // (`app.asar`, both themes: `#81858c` light / `#adb2b8` dark), because the live inspect query was
  // unavailable when the contrast pass needed it. It is the dimmest *label* role, which is what a
  // timestamp, a placeholder and a lane count are.
  //
  // The four `--dsw-alias-scrollbar-*` / `--dsw-alias-bg-document-selection` names were re-read from
  // the same compiled stylesheet on 2026-10-16, because the polish pass themes the browser surfaces
  // the craft floor asks about (text selection, the scrollbars of the sideways board and the drawer
  // body) and those are the app's own tokens for exactly that. Each resolves in both scopes:
  // `scrollbar-bg-l1` -> `var(--dsw-static-neutral-200)` light / `neutral-700` dark; `bg-l2` ->
  // `neutral-200`/`neutral-600`; `hover-l1` -> `neutral-300`/`neutral-600`;
  // `bg-document-selection` -> `color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent)` in
  // both. None is an invented name, and each keeps a literal fallback like every other token here.
  //
  // The source text **is** the contract here, deliberately: the question is which *names* the app's
  // theme provides, and that is a fact about the app, not about this run. jsdom resolves no custom
  // properties and the app is not running in this process, so a behavioural check ("does it look
  // right?") is not available; the built bundle's `var()` references against this transcribed list
  // is the only honest check. What it cannot see is a rule that names a real token but loses the
  // cascade — that is what the dark-block parse and the capture are for.
  const THEME_TOKENS = new Set([
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-document-selection',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-scrollbar-bg-l1',
    '--dsw-alias-scrollbar-bg-l2',
    '--dsw-alias-scrollbar-hover-l1',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ]);

  const bundle = readFileSync(new URL('../lib/v1/client.js', import.meta.url), 'utf8');
  const referenced = [...new Set([...bundle.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1] as string))];
  assert.ok(referenced.length > 0, 'the bundle should style itself with the theme, not with literals only');

  // A variable the stylesheet defines itself is legitimate; an unknown `--dsh-*`/`--dsw-*` is not.
  const defined = new Set([...bundle.matchAll(/(--kb-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string));
  const unknown = referenced.filter((name) => !THEME_TOKENS.has(name) && !defined.has(name));
  assert.deepEqual(unknown, [], 'these variables do not exist in the app theme and would fall back to literals');
});

// ------------------------------------------------------------------ pass 2: parity, legibility, craft

test('A1: creation is a title and Add, and the card takes the store defaults', async () => {
  const view = await mountBoard(loadBundle());
  await view.type('input[aria-label="New card title"]', 'a human card');
  await view.click('[data-action="create"]');
  await flush();

  const body = lastMutation()?.body as Record<string, unknown> | undefined;
  assert.equal(body?.op, 'create');
  // The create row is a title and Add. Priority and class are the host's defaults here
  // (`p2-normal` / `standard`), and the drawer is where the human sets them.
  assert.deepEqual(body?.input, { title: 'a human card' });
  assert.equal(view.has('[data-select="new-priority"]'), false, 'no priority control in the create row');
  assert.equal(view.has('[data-select="new-class"]'), false, 'no class control in the create row');
  view.unmount();
});

test('A1: the drawer still sets priority and class of service, and they reach the host', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-003"]');
  await flush();
  assert.equal((view.find('[data-select="priority"]') as { value?: string } | null)?.value, 'p2-normal');
  assert.equal((view.find('[data-select="class"]') as { value?: string } | null)?.value, 'standard');

  await view.type('[data-select="priority"]', 'p0-critical');
  await flush();
  let body = lastMutation()?.body as Record<string, unknown> | undefined;
  assert.equal(body?.op, 'update');
  assert.deepEqual(body?.patch, { priority: 'p0-critical' });

  await view.type('[data-select="class"]', 'expedite');
  await flush();
  body = lastMutation()?.body as Record<string, unknown> | undefined;
  assert.equal(body?.op, 'update');
  assert.deepEqual(body?.patch, { classOfService: 'expedite' });
  view.unmount();
});

test('A2: Block waits for a real reason and sends it, one disclosure deep', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-003"]');
  await flush();
  // Blocking is rare and destructive-adjacent, so it lives behind `More…` — but it is still there,
  // still disabled until the reason is written, and still sends what the human wrote.
  assert.equal(view.has('[data-field="block-reason"]'), false, 'not competing with the move');
  await view.click('[data-action="more"]');
  await flush();
  assert.equal(view.find('[data-action="block"]')?.hasAttribute('disabled'), true, 'an empty reason cannot block');
  assert.equal(view.find('[data-field="block-reason"]')?.getAttribute('placeholder'), 'reason to block…');

  await view.type('[data-field="block-reason"]', 'waiting on the host route');
  await flush();
  assert.equal(view.find('[data-action="block"]')?.hasAttribute('disabled'), false);
  await view.click('[data-action="block"]');
  await flush();

  const body = lastMutation()?.body as Record<string, unknown> | undefined;
  assert.equal(body?.op, 'block');
  assert.equal(body?.reason, 'waiting on the host route');
  assert.equal(String(body?.reason).includes('panel'), false, 'the hardcoded reason is gone');
  view.unmount();
});

test('A3: Done is refused locally, then force carries a written reason through the same gate', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-003"]');
  await flush();

  // T-003's Definition of Done is unticked, so the plain move never reaches the host. `Done` is not
  // the drawer's one obvious move for an in-progress card, so it is reached through `More…`.
  await view.click('[data-action="more"]');
  await flush();
  await view.click('[aria-label="Move T-003 to Done"]');
  await flush();
  assert.equal(lastMutation(), undefined, 'the local gate refuses before the round trip');
  assert.match(view.text(), /cannot enter done/);

  await view.click('[data-action="exception"]');
  await flush();
  assert.equal(view.find('[data-action="except"]')?.hasAttribute('disabled'), true, 'no reason, no exception');
  await view.type('[data-select="exception-target"]', 'done');
  await view.type('[data-field="exception-reason"]', 'shipping with the DoD unticked, agreed in review');
  await flush();
  assert.equal(view.find('[data-action="except"]')?.hasAttribute('disabled'), false);
  await view.click('[data-action="except"]');
  await flush();

  const body = lastMutation()?.body as Record<string, unknown> | undefined;
  assert.equal(body?.op, 'move');
  assert.equal(body?.toState, 'done');
  assert.equal(body?.force, true);
  assert.equal(body?.reason, 'shipping with the DoD unticked, agreed in review');
  // The reason is not cleared on send, so a host refusal is read beside what the human wrote.
  assert.equal(
    (view.find('[data-field="exception-reason"]') as { value?: string } | null)?.value,
    'shipping with the DoD unticked, agreed in review'
  );
  view.unmount();
});

test('A3: reopening a Done card through the exception control sends the reason and no force', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-005"]');
  await flush();

  // A finished card has no next state, so its drawer leads with `More…` rather than a move that
  // could only be refused.
  assert.equal(view.has('[data-action="more"]'), true);
  await view.click('[data-action="more"]');
  await flush();
  await view.click('[data-action="exception"]');
  await flush();
  await view.type('[data-select="exception-target"]', 'ready');
  await view.type('[data-field="exception-reason"]', 'the acceptance line changed, so it goes back');
  await flush();
  await view.click('[data-action="except"]');
  await flush();

  const body = lastMutation()?.body as Record<string, unknown> | undefined;
  assert.equal(body?.op, 'move');
  assert.equal(body?.toState, 'ready');
  assert.equal(body?.reason, 'the acceptance line changed, so it goes back');
  // `done → ready` passes `policy.checkMove` on the reason alone, so no gate was excepted. Sending
  // `force` anyway would append a `GateException` and an `exception` event that the same
  // `kanban_move` never writes, inflating the log the flow metrics are recomputed from.
  assert.equal(body?.force, undefined, 'a reopen is not a gate exception');
  view.unmount();
});

test('A3: a forced move the host refuses still shows the message and the missing list', async () => {
  const payload = fixture();
  setFetch((call) => {
    if (call.url.includes('/board')) return { status: 200, body: { ok: true, board: payload, rev: payload.rev } };
    if (call.url.includes('/mutate')) {
      return {
        status: 422,
        body: { ok: false, code: 'human-only', message: 'only the human may except a gate', missing: ['evidence'] },
      };
    }
    if (call.url.includes('/task/')) return { status: 200, body: { ok: true, task: null, comments: [], events: [] } };
    return { status: 404, body: {} };
  });
  const view = mount(loadBundle(), loadBundle().slot('main'), { store: freshStore(loadBundle()) });
  await flush();
  await view.click('[data-card="T-003"]');
  await flush();
  await view.click('[data-action="more"]');
  await flush();
  await view.click('[data-action="exception"]');
  await flush();
  await view.type('[data-select="exception-target"]', 'done');
  await view.type('[data-field="exception-reason"]', 'agreed in review');
  await flush();
  await view.click('[data-action="except"]');
  await flush();

  assert.equal(lastMutation()?.body.force, true);
  assert.match(view.text(), /only the human may except a gate/);
  assert.match(view.text(), /missing: evidence/, 'the host refusal, not a panel policy, has the last word');
  view.unmount();
});

test('B3: amber carries a word as well as a colour', async () => {
  const payload = fixture();
  const tasks = payload.tasks as Record<string, unknown>[];
  tasks.push({ ...(tasks[0] as Record<string, unknown>), id: 'T-010', state: 'ready', priority: 'p1-high', position: 1 });
  const view = await mountBoard(loadBundle(), { ...payload, tasks });

  // The word and the code are deliberately in different rows: the code stays in the cramped top row,
  // the word moves to the chip row, which wraps without splitting the id. Both must still be present,
  // and the top row must not wrap at all -- a wrapped row is what split "T-005" into "T-" and "005".
  const p1 = view.find('[data-card="T-010"]')?.textContent ?? '';
  assert.match(p1, /P1/, 'the code stays on the card');
  assert.match(p1, /high/, 'and the word survives, relocated');
  // T-005 started 3.5 days before the served time, past the 3-day SLE.
  const old = view.find('[data-card="T-005"]')?.textContent ?? '';
  assert.match(old, /3\.5d/);
  assert.match(old, /ageing/, 'the age band is a word, not only a colour');
  // The no-wrap declaration is CSS, and the source text is the contract for it (jsdom computes no
  // layout); the *effect* it protects is asserted above, on the rendered text of the card.
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  assert.match(styles, /\.kb-card-top \{ display: flex; gap: 7px; align-items: baseline; flex-wrap: nowrap; \}/);
  assert.match(styles, /\.kb-card-top > \* \{ white-space: nowrap; \}/);
  view.unmount();
});

test('B4: one entity, one spelling — labels, never store slugs, on cards and in the drawer', async () => {
  const view = await mountBoard(loadBundle());
  const card = view.find('[data-card="T-004"]')?.textContent ?? '';
  assert.match(card, /P0/, 'the code is on the card');
  assert.match(card, /critical/, 'and its word, in the chip row');
  assert.equal(card.includes('p0-critical'), false, 'no raw priority slug on a card');
  assert.equal(card.includes('in-progress'), false, 'no raw state slug on a card');

  await view.click('[data-card="T-003"]');
  await flush();
  const drawer = view.find('[data-drawer="T-003"]')?.textContent ?? '';
  assert.match(drawer, /In Progress/, 'the head chip uses the lane vocabulary');
  assert.match(drawer, /→ Review/, 'and so does the move button');
  assert.equal(drawer.includes('→ review'), false);
  assert.equal(drawer.includes('p2-normal'), false, 'the drawer does not print the raw priority');
  view.unmount();
});

test('C3: checklist states are drawn, not typed as Unicode', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-001"]');
  await flush();
  const drawer = view.find('[data-drawer="T-001"]');
  const text = drawer?.textContent ?? '';

  assert.equal(text.includes('☐'), false, 'no Unicode box');
  assert.equal(text.includes('☑'), false, 'no Unicode tick');
  assert.ok((drawer?.querySelectorAll('button[aria-pressed] svg[aria-hidden="true"]').length ?? 0) > 0);
  // The unticked DoD rows say so in words, because amber alone fails AA on light.
  assert.match(text, /· unticked/);
  view.unmount();
});

test('C4: the Alt+arrow path is surfaced on the drawer and the lanes', async () => {
  const view = await mountBoard(loadBundle());
  assert.equal(
    view.find('[data-card="T-003"]')?.getAttribute('aria-keyshortcuts'),
    'Alt+ArrowLeft Alt+ArrowRight'
  );
  assert.equal(
    view.find('[data-lane="ready"]')?.getAttribute('aria-keyshortcuts'),
    'Alt+ArrowLeft Alt+ArrowRight'
  );

  await view.click('[data-card="T-003"]');
  await flush();
  assert.match(view.text(), /Alt\+←\/→ moves/);
  view.unmount();
});

test('C5: done carries a drawn success mark, an unfinished card does not', async () => {
  const view = await mountBoard(loadBundle());
  // Assert the drawn mark, not a class name: the class had no CSS rule anywhere (DESIGN.md recorded it
  // as an open question), so asserting it was a test that could not fail. The visible mark is the SVG.
  const mark = view.find('[data-card="T-005"] .kb-mark');
  assert.equal(mark?.tagName.toLowerCase(), 'svg');
  assert.equal(mark?.getAttribute('aria-hidden'), 'true', 'decorative: the lane header already says Done');
  assert.ok(view.find('[data-card="T-003"] .kb-mark') === null, 'the unreviewed card is not marked');
  view.unmount();
});

test('C8: an empty lane is a rail, opens while a drag is live, and still takes the drop', async () => {
  const view = await mountBoard(loadBundle());
  assert.equal(view.find('[data-lane="review"]')?.className.includes('kb-lane-empty'), true, 'zero cards, a rail');

  await view.dragStart('[data-card="T-002"]');
  await flush();
  assert.equal(
    view.find('[data-lane="review"]')?.className.includes('kb-lane-awake'),
    true,
    'the rail opens so the target is hittable'
  );

  // T-002 is ready and review is within its limit, so the drop lands through the normal path.
  await view.drag('[data-card="T-002"]', '[data-lane="review"]', 5);
  await flush();
  const body = lastMutation()?.body as Record<string, unknown> | undefined;
  assert.equal(body?.op, 'move');
  assert.equal(body?.toState, 'review');
  view.unmount();
});

test('C9: the drawer leads with one move and keeps the rest of its actions behind More…', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-003"]');
  await flush();

  // T-003 is in progress, so the one obvious move is the next state in the board's own order.
  assert.equal(view.find('[aria-label="Move T-003 to Review"]')?.textContent, '→ Review');
  assert.equal(view.find('[data-action="more"]')?.getAttribute('aria-expanded'), 'false');
  assert.equal(view.has('[data-field="position"]'), false, 'the number is not competing with the move');
  assert.equal(view.has('[data-action="drop"]'), false, 'nor is the destructive action');
  assert.equal(view.has('[data-action="block"]'), false);

  await view.click('[data-action="more"]');
  await flush();
  assert.equal(view.find('[data-action="more"]')?.getAttribute('aria-expanded'), 'true');
  // Every other target is still a button: the disclosure widens the choice, it does not replace it.
  assert.equal(view.find('[aria-label="Move T-003 to Done"]') !== null, true);
  assert.equal(view.find('[aria-label="Move T-003 to Backlog"]') !== null, true);
  assert.equal(view.has('[data-action="drop"]'), true);
  assert.equal(view.has('[data-action="block"]'), true);
  assert.equal(view.has('[data-drawer="T-003"] .kb-group-danger'), true, 'Drop is still set apart');

  assert.equal(view.find('[data-field="position"]')?.getAttribute('type'), 'number');
  assert.equal((view.find('[data-field="position"]') as { value?: string } | null)?.value, '0');
  assert.equal(view.find('[data-action="set-position"]')?.hasAttribute('disabled'), true, 'nothing to set yet');

  await view.type('[data-field="position"]', '4');
  await flush();
  await view.click('[data-action="set-position"]');
  await flush();
  const body = lastMutation()?.body as Record<string, unknown> | undefined;
  assert.equal(body?.op, 'move');
  assert.equal(body?.toState, 'in-progress');
  assert.equal(body?.toPosition, 4, 'the same number kanban_move.toPosition takes');
  view.unmount();
});

test('D1: the create row is a title and Add, and nothing else', async () => {
  const view = await mountBoard(loadBundle());
  assert.equal(view.has('input[aria-label="New card title"]'), true);
  assert.equal(view.has('[data-action="create"]'), true);
  assert.equal(view.has('[data-select="new-priority"]'), false);
  assert.equal(view.has('[data-select="new-class"]'), false);
  // Both are still settable, in the drawer — the control moved, the capability did not.
  await view.click('[data-card="T-002"]');
  await flush();
  assert.equal(view.has('[data-drawer="T-002"] [data-select="priority"]'), true);
  assert.equal(view.has('[data-drawer="T-002"] [data-select="class"]'), true);
  view.unmount();
});

test('D5: a card says only what demands attention, and the rest is in the drawer', async () => {
  const payload = fixture();
  const tasks = (payload.tasks as Record<string, unknown>[]).map((task) =>
    task.id === 'T-002'
      ? { ...task, assignee: 'agent:qa', project: 'dsh-kanban', sprintId: 'S-001', classOfService: 'fixed-date' }
      : task
  );
  const view = await mountBoard(loadBundle(), { ...payload, tasks });

  const card = view.find('[data-card="T-002"]')?.textContent ?? '';
  assert.match(card, /card T-002/, 'the title is still the card');
  assert.equal(card.includes('agent:qa'), false, 'no assignee chip');
  assert.equal(card.includes('dsh-kanban'), false, 'no project chip');
  assert.equal(card.includes('S-001'), false, 'no sprint chip');
  assert.equal(card.includes('Fixed date'), false, 'no class chip for a class with no consequence');

  // Every one of those facts is still one click away: the drawer already prints them.
  await view.click('[data-card="T-002"]');
  await flush();
  const drawer = view.find('[data-drawer="T-002"]')?.textContent ?? '';
  assert.match(drawer, /agent:qa/);
  assert.match(drawer, /dsh-kanban/);
  assert.match(drawer, /S-001/);
  assert.match(drawer, /Fixed date/);
  view.unmount();
});

test('D5: expedite keeps its word, so the red hairline is never the only signal', async () => {
  const view = await mountBoard(loadBundle());
  // The class is a fact about the card, not a demand on the reader — except for `expedite`, which
  // is the one exception to a WIP limit. Its chip stays; the others moved to the drawer.
  assert.match(view.find('[data-card="T-004"]')?.textContent ?? '', /Expedite/);
  assert.equal((view.find('[data-card="T-003"]')?.textContent ?? '').includes('Standard'), false);
  view.unmount();
});

test('D6: a blocked card says so, and Unblock is on the notice that names the blocker', async () => {
  const payload = fixture();
  const tasks = (payload.tasks as Record<string, unknown>[]).map((task) =>
    task.id === 'T-002' ? { ...task, blockedReason: 'waiting on the host route' } : task
  );
  const view = await mountBoard(loadBundle(), { ...payload, tasks });
  assert.match(view.find('[data-card="T-002"]')?.textContent ?? '', /blocked/);

  await view.click('[data-card="T-002"]');
  await flush();
  const notice = view.find('[data-drawer="T-002"] .kb-notice-refusal');
  assert.match(notice?.textContent ?? '', /Blocked: waiting on the host route/);
  // A blocked card is the one case where the obvious move is not a move: the fix sits on the notice
  // rather than behind `More…` with the action that caused it.
  assert.equal(notice?.querySelector('[data-action="unblock"]') !== null, true);

  await view.click('[data-drawer="T-002"] [data-action="unblock"]');
  await flush();
  const body = lastMutation()?.body as Record<string, unknown> | undefined;
  assert.equal(body?.op, 'unblock');
  view.unmount();
});

test('the pass-2 stylesheet rules are authored, and the states they style are rendered', async () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  // These are declarations, so the source text is the contract for *appearance*: jsdom resolves no
  // custom properties, so there is no computed style to assert against. What a test can check
  // besides the declaration is that the states exist to be styled at all — an authored rule for a
  // class the panel never renders is dead in a second way, and this is that half.
  // B1: pressed is a tint plus weight, and never the brand token as a background. An open disclosure
  // takes the same treatment (P3.8), so the selector list is shared and both halves are asserted.
  assert.match(styles, /\.kb-btn\[aria-pressed="true"\], \.kb-more\[aria-expanded="true"\] \{[^}]*background: var\(--dsw-alias-bg-layer-2/);
  assert.match(styles, /\.kb-btn\[aria-pressed="true"\], \.kb-more\[aria-expanded="true"\] \{[^}]*font-weight: 600/);
  assert.match(styles, /\.kb-more-caret \{[^}]*transition: transform 140ms ease-out/);
  assert.match(styles, /\.kb-more\[aria-expanded="true"\] \.kb-more-caret \{ transform: rotate\(90deg\); \}/);
  // B6: the drawer is capped in pixels and the lanes keep a floor.
  assert.match(styles, /\.kb-drawer \{[^}]*max-height: 260px/);
  assert.match(styles, /\.kb-lanes \{[^}]*min-height: 140px/);
  assert.equal(styles.includes('max-height: 46%'), false, 'the drawer no longer takes half the board');
  // B8: the drop target reads in dark without the monochrome brand token.
  assert.match(styles, /\.kb-lane-over \{[^}]*background: var\(--dsw-alias-bg-layer-2/);
  assert.match(styles, /\.kb-lane-over \{[^}]*outline: 2px dashed var\(--dsw-alias-label-secondary/);
  // C8: the rail and the state that opens it.
  assert.match(styles, /\.kb-lane-empty \{[^}]*flex: 0 0 46px/);
  assert.match(styles, /\.kb-lane-awake \{[^}]*flex: 0 0 var\(--kb-lane-width/);

  // The behavioural half: the panel really reaches the classes those rules name. `.kb-lane-empty`
  // is the review lane (zero cards), `.kb-lane-awake` is what a live drag adds, pressed and the
  // drawer are the states B1/B6 style, and the drop-target class is reached by a drag onto a lane.
  const view = await mountBoard(loadBundle());
  assert.equal(view.has('.kb-lanes'), true);
  assert.equal(view.find('[data-lane="review"]')?.className.includes('kb-lane-empty'), true);
  await view.dragStart('[data-card="T-002"]');
  await flush();
  assert.equal(view.find('[data-lane="review"]')?.className.includes('kb-lane-awake'), true);
  assert.equal(view.has('.kb-btn[aria-pressed="true"]'), true);
  await view.click('[data-card="T-003"]');
  await flush();
  assert.equal(view.has('.kb-drawer'), true);
  view.unmount();
});

test('the store reports the document origin, because same-origin is the whole diagnosis', () => {
  const transport = { streamBaseUrl: 'http://127.0.0.1:19387/stream' };

  // A static desktop page: `file://`, so the request is cross-origin and carries `Origin: null`.
  const staticPage = resolveOrigin({ transport, location: { protocol: 'file:', origin: 'null', href: 'file:///app/index.html' } });
  assert.equal(staticPage.origin, 'http://127.0.0.1:19387', 'the transport supplies the host origin');
  assert.equal(staticPage.source, '__DSH_TRANSPORT__.streamBaseUrl');
  assert.equal(staticPage.document.protocol, 'file:');
  assert.equal(staticPage.document.baseURI, 'file:///app/index.html');

  // A page served by the app: same-origin, no preflight, no CORS.
  const served = resolveOrigin({ transport, location: { protocol: 'http:', origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/' } });
  assert.equal(served.document.protocol, 'http:');
  assert.equal(served.document.origin, 'http://127.0.0.1:19387');

  // And with nothing at all, the fields exist rather than throwing.
  const bare = resolveOrigin({});
  assert.equal(bare.document.protocol, '(none)');
  assert.equal(bare.source, 'fallback constant');
});

test('no colour that fails AA on light carries text there', () => {
  // Measured with scripts/capture-panel.mts against the app's own resolved token values (2026-10-16):
  // light `#f59e0b` on `#fff` is 2.15:1 and `#dd8629` is 2.79:1 — no amber in the app's scale reaches
  // AA for small text on white. `--dsw-alias-label-tertiary` is 8.54:1 in dark and only 3.71:1 in light.
  // So both are allowed as *enhancement* only, behind the app's own dark marker; the default must be a
  // value that passes in light. This is the class of bug that only the light capture could find, and it
  // is the reason a dark-only review is not a review.
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');

  // Split into rules, and for each rule that paints *text* with a failing-on-light token, require the
  // selector to be scoped to the dark theme.
  const failingOnLight = ['--dsw-alias-state-warn-primary', '--dsw-alias-label-tertiary'];
  const rules = styles.match(/[^{}]+\{[^{}]*\}/g) ?? [];
  const offenders = rules.filter((rule) => {
    const [selector, body] = rule.split('{');
    // `color:` only — `border-color:`/`background-color:` are not text and carry different rules.
    if (!/(?<![-\w])color\s*:/.test(body ?? '')) return false;
    if (!failingOnLight.some((token) => (body ?? '').includes(`var(${token}`))) return false;
    return !(selector ?? '').includes('data-ds-dark-theme');
  });
  assert.deepEqual(offenders, [], 'a colour that fails AA on light may not carry text outside the dark scope');

  // And the positive half, proved structurally rather than by looking for the marker string: every
  // dark rule must be a real, well-formed selector list, and the classes it restores must be on one.
  // The literal search this replaces stayed green over a dark block that parsed to nothing.
  const dark = darkScopedRules(styles);
  assert.ok(dark.length >= 2, 'both dark blocks are still authored');
  const restored = dark.join('\n');
  for (const cls of ['.kb-pri-p1', '.kb-age-ageing', '.kb-check-missing', '.kb-sub', '.kb-input::placeholder', '.kb-empty']) {
    assert.ok(restored.includes(cls), `${cls} is restored in dark`);
  }
});

test('the dark-block detector fails on the pre-fix, comment-split selector list', () => {
  // The rule that caught this shipped dead: a dangling `body[data-ds-dark-theme]` before a comment
  // made one selector chain onto the next, and the old literal-marker assertion could not see it.
  // This reproduces that exact shape so the detector is proved to have teeth in-repo.
  const preFix = [
    '.kb-pri-p1 { color: var(--dsw-alias-label-primary, inherit); }',
    'body[data-ds-dark-theme] .kb-pri-p1,',
    'body[data-ds-dark-theme] .kb-age-ageing,',
    'body[data-ds-dark-theme] ',
    '/* the comment that split the selector list */',
    'body[data-ds-dark-theme] .kb-sub { color: var(--dsw-alias-label-tertiary, #81858c); }',
  ].join('\n');
  assert.throws(() => darkScopedRules(preFix), /comment inside a dark selector list/);
  // A well-formed list of the same shape passes, so the detector rejects the split and not the scope.
  const fixed = [
    'body[data-ds-dark-theme] .kb-pri-p1,',
    'body[data-ds-dark-theme] .kb-age-ageing { color: var(--dsw-alias-state-warn-primary, #d68945); }',
  ].join('\n');
  assert.equal(darkScopedRules(fixed).length, 1);
});
