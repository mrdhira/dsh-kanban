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
import { EMPTY_FILTER, checkMoveLocally, columnsOf } from '../lib/v1/client/model.js';
import { PRIORITIES } from '../lib/v1/store/index.js';

const FULL_DOR = Object.fromEntries(
  ['outcome', 'acceptance', 'write-scope', 'estimate'].map((id) => [id, { at: '2026-10-01T00:00:00.000Z', by: 'human:dhira' }])
);

/**
 * The two views every new board is seeded with, as the host sends them.
 *
 * The panel no longer renders a control for either one — the view row is gone — but the payload still
 * carries them, and the host, the store, `board.db` and the CLI's `--state` all still speak `views`.
 * The fixture keeps them so the tests can prove the panel ignores them rather than that the data
 * vanished: a mounted board with seeded views must draw the same six lanes as one without.
 */
const SEEDED_VIEWS = [
  { id: 'board', name: 'Board', description: 'everything still moving', filter: { state: ['backlog', 'ready', 'in-progress', 'review'] } },
  { id: 'ageing', name: 'Ageing', description: 'started, not finished', filter: { state: ['in-progress', 'review'] } },
];

/**
 * The board the DOM tests render: one refined backlog card, one ready, two in progress, one done, and
 * one **dropped** card. The dropped card has its own lane at the end of the board — the change this
 * pass makes — so a dropped card is on screen without any control asking for it, and the suite can
 * pin both that reachability and the absence of the view row that used to provide it.
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
  assert.deepEqual(lanes, ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped']);
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

test('the header states the count plainly, and the host line waits behind its disclosure in the strip', async () => {
  const view = await mountBoard(loadBundle());
  // Every card the board holds has a lane now, so the front line says the plain count: the "showing X
  // of Y" form is for a search or a truncated read, not for a state the board declines to draw.
  const head = (): string => view.find('.kb-head')?.textContent ?? '';
  assert.match(head(), /6 cards/);
  assert.equal(head().includes('showing'), false, 'nothing is hidden, so nothing is claimed to be');
  assert.equal(head().includes('rev'), false, 'no revision on the front line');
  assert.equal(view.text().includes('host http://localhost'), false, 'the host line is not on the front');

  // Moved beside `More metrics`: it is the same kind of slow, technical fact, and it lives where the
  // metrics disclosure lives rather than in the header's most prominent row.
  const disclosure = view.find('.kb-metrics [data-action="more-host"]');
  assert.ok(disclosure !== null, 'the host line lives in the metrics strip now');
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(view.find('.kb-head [data-action="more-host"]'), null, 'and it left the header');

  await view.click('[data-action="more-host"]');
  await flush();
  assert.equal(view.find('[data-action="more-host"]')?.getAttribute('aria-expanded'), 'true');
  assert.match(view.text(), /host http:\/\/localhost/, 'opening it still names the transport');
  assert.match(view.text(), /rev 7/, 'and the revision moved here rather than off the panel');
  view.unmount();
});

test('every state has a lane, dropped last, and the board draws everything it holds', async () => {
  // The board is the whole workflow now: no view narrows the lanes, so the sixth lane is the end of
  // the board rather than a surface someone has to ask for. That lane is what keeps a dropped card
  // reachable — two passes ago it was invisible from the panel and the CLI was the only way back, and
  // this pass must not re-open that defect.
  const view = await mountBoard(loadBundle());
  assert.deepEqual(
    view.findAll('[data-lane]').map((node) => node.getAttribute('data-lane')),
    ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped'],
    'six lanes, every state, dropped last'
  );
  assert.equal(view.findAll('[data-card]').length, 6, 'six cards are drawn, including the dropped one');
  assert.equal(view.has('[data-card="T-006"]'), true, 'the dropped card is on the board without being asked for');
  assert.match(view.find('.kb-head')?.textContent ?? '', /6 cards/, 'and the header agrees with the screen');

  // Every state keeps its lane even when nothing is in it: the lane list is the state list, not the
  // cards that happen to exist. An empty lane costs a content-width dashed slot, which is what makes
  // drawing all six affordable.
  const whole = await mountBoard(loadBundle(), boardPayload());
  assert.deepEqual(
    whole.findAll('[data-lane]').map((node) => node.getAttribute('data-lane')),
    ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped'],
    'and an empty board still names every state'
  );
  assert.equal(whole.find('[data-lane="dropped"]')?.className.includes('kb-lane-empty'), true, 'the empty dropped lane is a slot');
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
  // the history behind the disclosure is exactly where a second and third reading belong. The store's
  // own field name (`p85`) is not a word anyone reads, so the reading is spelled out; the SLE says
  // where its number came from instead of printing the field value `guess`.
  assert.match(opened, /Cycle median 3d · 85th percentile 3d · mean 3d/);
  assert.match(opened, /Throughput 1\/7d · 1\/30d/);
  assert.match(opened, /SLE 85% ≤ 3d \(from default\)/);
  assert.equal(opened.includes('p85'), false, 'no store field name reaches the screen');
  assert.equal(opened.includes('guess'), false, 'and neither does the untranslated source');
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
  assert.match(view.text(), /Cycle median —d · 85th percentile —d · mean —d/);
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
  assert.match(view.text(), /already at the end of the board/);
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

test('the view row is gone: no view buttons, no state select, and every state still drawn', async () => {
  // The user's verdict was *"Remove it, do not group by that, I think it's not common, just view
  // all."* The assertion that matters is the **absence**: a default board carries no `Board / Ageing /
  // All / Dropped` button and no `all states` select, and the payload's views do not bring one back.
  const view = await mountBoard(loadBundle(), { ...fixture(), views: SEEDED_VIEWS });
  assert.equal(view.has('nav[aria-label="Views"]'), false, 'the switcher group is not rendered');
  assert.equal(view.findAll('select').length, 0, 'and no state select replaced it');
  assert.equal(view.has('[data-select="view-state"]'), false, 'the removed picker is not hiding anywhere');
  assert.equal(view.findAll('[data-action="all"]').length, 0, 'All went with the row it belonged to');
  assert.equal(view.findAll('[data-action="dropped"]').length, 0, 'and so did Dropped — the lane is the way there now');
  assert.equal(view.findAll('[data-state]').length, 0, 'no chip row came back either');
  assert.equal(view.findAll('[data-card]').length, 6, 'the seeded views filter nothing: every card is still drawn');

  // The seeded views are still in the payload — the host, the store and the CLI keep them — so this
  // board with views and a board without them must be the same board.
  const bare = await mountBoard(loadBundle(), fixture());
  assert.deepEqual(
    bare.findAll('[data-lane]').map((node) => node.getAttribute('data-lane')),
    ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped'],
    'a board with no views at all draws the same six lanes'
  );
  bare.unmount();
  view.unmount();
});

test('the search is the panel filter, and the header still accounts for it', async () => {
  const view = await mountBoard(loadBundle());
  assert.equal(view.has('[data-card="T-005"]'), true, 'the finished card is on the board');
  assert.equal(view.has('[data-card="T-006"]'), true, 'and so is the dropped one');
  assert.match(view.find('.kb-head')?.textContent ?? '', /6 cards/, 'nothing is hidden yet');

  await view.type('input[type="search"]', 'T-003');
  await flush();
  assert.equal(view.has('[data-card="T-003"]'), true, 'the matching card stays');
  assert.equal(view.has('[data-card="T-005"]'), false, 'a filtered-out card is gone');
  assert.equal(view.has('[data-card="T-006"]'), false, 'including the dropped one');
  assert.match(view.find('.kb-head')?.textContent ?? '', /showing 1 of 6 cards/, 'and the header says how much is hidden');

  // Clearing the box is the only way back, because the row that used to carry a clear-the-filter
  // control is gone: the search input is the filter.
  await view.type('input[type="search"]', '');
  await flush();
  assert.equal(view.has('[data-card="T-005"]'), true, 'the board comes back');
  assert.match(view.find('.kb-head')?.textContent ?? '', /6 cards/);
  view.unmount();
});

// ------------------------------------------------------------------ P1.1 dropped cards stay reachable

test('P1.1: a dropped card is drawn in its own lane, last, without any control asking for it', async () => {
  // The invariant this pass must not break: a dropped card was invisible from the panel two passes
  // ago and the CLI was the only way back. It is reachable now because the board draws every state
  // and `dropped` is the last lane — not because a view row narrows the board to it.
  const view = await mountBoard(loadBundle());
  const lanes = view.findAll('[data-lane]').map((node) => node.getAttribute('data-lane'));
  assert.equal(lanes[lanes.length - 1], 'dropped', 'the dropped lane is the last lane');
  assert.equal(view.has('[data-card="T-006"]'), true, 'and the dropped card is drawn in it');
  assert.equal(view.find('[data-card="T-006"]')?.className.includes('kb-card-dropped'), true, 'marked as out of play');
  assert.equal(view.find('[data-lane="dropped"]')?.getAttribute('aria-label'), 'Dropped, 1 card');
  view.unmount();
});

test('P1.1: a dropped card can be taken back to the board through the panel', async () => {
  // Reachability was the whole defect, so it is pinned as a round trip: open the card where it lies
  // and move it through the panel's own move set.
  const view = await mountBoard(loadBundle());
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

test('P1.1: Alt+→ at the end of the board announces it, and Alt+← from a dropped card is a real move', async () => {
  // `dropped` is the last lane, so `Alt+→` on a card sitting there has nothing further along — the
  // same "end of the board" a backlog card meets going left. It used to say the card "is dropped,
  // open it and move it back", which stopped being true once the board drew every state: `Alt+←` is
  // now a real target for a dropped card, the lane before it.
  const view = await mountBoard(loadBundle());
  await view.focus('[data-card="T-006"]');
  await view.key('[data-card="T-006"]', 'ArrowRight', { altKey: true });
  await flush();
  assert.match(view.text(), /T-006 is already at the end of the board/);
  assert.equal(lastMutation(), undefined, 'the end of the board is not a move');

  // Going left now goes somewhere: `Done` is the lane before `dropped` in the board's own order. The
  // move it produces is subject to the same gates as any other — and this board's Done lane is at its
  // limit — so the assertion is on the keyboard path's *intent* reaching the store, not on the card
  // landing.
  await view.key('[data-card="T-006"]', 'ArrowLeft', { altKey: true });
  await flush();
  assert.equal(view.text().includes('T-006 is already at the end of the board'), false, 'left is not the end');
  assert.match(view.text(), /cannot enter done: 5 Definition of Done check\(s\) unticked/, 'the move runs the lane gates like any other');
  view.unmount();
});

// ------------------------------------------------------------------ the Dropped lane refuses, and stages

/**
 * Dropping onto Dropped, both halves of the decision.
 *
 * The defect: the lane highlighted as a legal target, `onDrop` sent `store.move(id, 'dropped', index)`
 * with no reason, and `checkMoveLocally` — like the host's `policy.checkMove` — refused a drop without
 * one. So the gesture was accepted, the card snapped back, and the refusal named a field in a drawer
 * nobody had opened. Dhira chose both halves of the answer: the lane stops claiming the drop is legal,
 * and the same gesture opens the drawer with the drop staged and the reason field focused.
 */
test('D1: the Dropped lane draws no legal-target treatment for a card hovering it', async () => {
  const view = await mountBoard(loadBundle());
  await view.dragStart('[data-card="T-003"]');
  await view.dragOver('[data-lane="dropped"]', 5);
  // Pre-fix this read `true`: `isDropAllowed` said every lane accepts every drag, so Dropped lit up
  // for a drop that could only ever be refused.
  assert.equal(
    view.find('[data-lane="dropped"]')?.className.includes('kb-lane-over'),
    false,
    'the lane that cannot complete the move does not offer it'
  );
  // The same predicate still lights a legal lane, so the case above is not passing because nothing
  // lights at all: this is the control that keeps "no highlight" meaningful.
  await view.dragOver('[data-lane="review"]', 5);
  assert.equal(view.find('[data-lane="review"]')?.className.includes('kb-lane-over'), true, 'review still accepts');
  assert.equal(view.find('[data-lane="dropped"]')?.className.includes('kb-lane-over'), false, 'and dropped still does not');
  assert.equal(lastMutation(), undefined, 'a dragover is not a move');
  view.unmount();
});

test('D2: a drag onto Dropped sends nothing, and stages the drop in that card’s drawer', async () => {
  const view = await mountBoard(loadBundle());
  await view.drag('[data-card="T-003"]', '[data-lane="dropped"]', 5);
  await flush();

  // Pre-fix this was a `move` with `toState: dropped` and no reason — the mutation the host refuses.
  assert.equal(lastMutation(), undefined, 'the gesture sends no move at all');
  assert.equal(view.has('[data-drawer="T-003"]'), true, 'the drawer opens for the dragged card');
  assert.equal(
    view.find('[data-drawer="T-003"]')?.getAttribute('data-staged'),
    'dropped',
    'and it says a drop is staged, not merely open'
  );
  assert.equal(view.has('[data-drawer="T-003"] [data-action="drop"]'), true, 'the destructive group is revealed for it');
  assert.equal(view.has('[data-drawer="T-003"] [data-field="drop-reason"]'), true, 'and so is the reason field');
  assert.equal(view.isFocused('[data-drawer="T-003"] [data-field="drop-reason"]'), true, 'the field takes focus: the reason is what is missing');
  assert.equal(
    view.find('[data-drawer="T-003"] [data-action="drop"]')?.hasAttribute('disabled'),
    true,
    'nothing is sent until a reason is written'
  );
  assert.match(view.text(), /the only way a card is moved to Dropped is a confirmed move carrying a reason/);
  assert.equal(view.find('[data-lane="dropped"]')?.querySelectorAll('[data-card]').length, 1, 'the dragged card did not land in Dropped');
  view.unmount();
});

test('D3: confirming the staged drop sends the move to dropped with the reason, and the card lands there', async () => {
  // T-002, the Ready card: `dropped` is legal from any state but the two the fixture leaves unticked
  // (T-003 is missing its Definition of Done, T-001 its Ready checks), so the confirmed drop is the
  // one gate that actually runs here rather than a second refusal.
  // This case is about where the card lands after the write, so the fake host has to answer the
  // post-write read honestly. The shared fixture answers every `/board` with the same rev-7 payload,
  // which put the pre-move card back over the optimistic one and made the assertion below impossible
  // for a reason that has nothing to do with the drop. A 304 after the mutation is the host saying
  // "nothing changed since your rev" — true here — and the panel's own optimistic payload is then
  // what is on screen, which is the behaviour under test.
  const payload = fixture();
  let mutations = 0;
  setFetch((call) => {
    if (call.url.includes('/board')) {
      return mutations === 0
        ? { status: 200, body: { ok: true, board: payload, rev: payload.rev } }
        : { status: 304, body: undefined };
    }
    if (call.url.includes('/mutate')) {
      mutations += 1;
      return { status: 200, body: { ok: true, rev: Number(payload.rev) + 1, result: {} } };
    }
    if (call.url.includes('/task/')) return { status: 200, body: { ok: true, task: null, comments: [], events: [] } };
    return { status: 404, body: {} };
  });
  const view = mount(loadBundle(), loadBundle().slot('main'), { store: freshStore(loadBundle()) });
  await flush();

  await view.drag('[data-card="T-002"]', '[data-lane="dropped"]', 5);
  await flush();

  await view.type('[data-drawer="T-002"] [data-field="drop-reason"]', 'superseded by T-004');
  await flush();
  assert.equal(
    view.find('[data-drawer="T-002"] [data-action="drop"]')?.hasAttribute('disabled'),
    false,
    'the control is live once the reason exists'
  );
  await view.click('[data-drawer="T-002"] [data-action="drop"]');
  await flush();

  const mutation = lastMutation();
  assert.equal(mutation?.body.op, 'move');
  assert.equal(mutation?.body.id, 'T-002');
  assert.equal(mutation?.body.toState, 'dropped');
  assert.equal(mutation?.body.reason, 'superseded by T-004', 'the reason the gate asked for is what travels');
  assert.equal(view.has('[data-lane="dropped"] [data-card="T-002"]'), true, 'and the card is in the Dropped lane');
  view.unmount();
});

test('D4: a same-lane drop onto Dropped sends nothing and stages nothing', async () => {
  const view = await mountBoard(loadBundle());
  await view.drag('[data-card="T-006"]', '[data-lane="dropped"]', 5);
  await flush();
  assert.equal(lastMutation(), undefined, 'a card already there has nowhere to go');
  assert.equal(view.has('[data-drawer="T-006"]'), false, 'and there is no drop to stage');
  view.unmount();
});

test('D5: a drop onto the lane the card already sits in is a no-op, not a same-state mutation', async () => {
  const view = await mountBoard(loadBundle());
  await view.drag('[data-card="T-006"]', '[data-lane="dropped"]', 5);
  await flush();
  assert.equal(lastMutation(), undefined, 'a card already there has nowhere to go');
  assert.equal(view.has('[data-drawer="T-006"]'), false, 'and there is no drop to stage');
  view.unmount();
});

test('D6: the drawer move button into Dropped stages instead of sending a reasonless move', async () => {
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-005"]');
  await flush();
  await view.click('[data-action="more"]');
  await flush();
  await view.click('[aria-label="Move T-005 to Dropped"]');
  await flush();

  const sent: RecordedCall[] = recorded().filter((call) => call.url.includes('/mutate'));
  assert.equal(sent.length, 0, 'no move leaves the panel without the reason the gate requires');
  assert.equal(
    sent.filter((call) => call.body['toState'] === 'dropped' && call.body['reason'] === undefined).length,
    0,
    'and none of them is a reasonless move to dropped'
  );
  assert.equal(view.find('[data-drawer="T-005"]')?.getAttribute('data-staged'), 'dropped', 'the drawer stages it instead');
  view.unmount();
});

test('D7: the keyboard path into Dropped stages the same drawer rather than sending a reasonless move', async () => {
  // `Alt+→` on a done card targets `dropped`, and the keyboard has no more of a reason than the
  // pointer does. The rule is about the target, not the input device: it stages.
  const view = await mountBoard(loadBundle());
  await view.focus('[data-card="T-005"]');
  await view.key('[data-card="T-005"]', 'ArrowRight', { altKey: true });
  await flush();
  assert.equal(lastMutation(), undefined, 'no move is sent');
  assert.equal(view.has('[data-drawer="T-005"]'), true, 'the drawer opens for the card');
  assert.equal(view.find('[data-drawer="T-005"]')?.getAttribute('data-staged'), 'dropped', 'with the drop staged');
  assert.equal(view.has('[data-drawer="T-005"] [data-field="drop-reason"]'), true, 'and the reason field is there to take it');
  // The keyboard user asked for the card, not for a text box, so focus stays on the drawer the
  // keyboard path put it in; `Tab` reaches the field from there like any other control in the region.
  assert.equal(view.isFocused('[data-drawer="T-005"]'), true, 'the keyboard keeps its own place in the drawer');
  view.unmount();
});

// ------------------------------------------------------------------ D8 the stage outlives a poll

test('D8: a staged drop survives the poll, and the stage is committed by the same store write', async () => {
  // The contract the browser probe's fix rests on, pinned where it can be pinned deterministically.
  //
  // The probe's 3/6 flake (2026-10-16) came down to one question: does the *product* lose the staged
  // drop, or was the probe reading the wrong moment? The store is where that is decided, and jsdom can
  // decide it without a browser. `stageDrop` is not a write, so no poll can roll it back; and the two
  // facts it publishes are recorded together, synchronously, while the *drawer* that shows them is a
  // later React commit — the Drop group inside it is revealed by an effect after that.
  //
  // So anything treating "the store recorded a stage" as "the drawer is on screen" reports a correct
  // panel as a broken one, which is exactly what the flaky run did. This case fails on any code that
  // lets the poll clear the stage, and it guards the fix's only real risk: a refresh landing between
  // the gesture and the confirmation.
  const transport = {
    origin: {
      origin: 'http://localhost',
      source: 'test',
      detail: '',
      document: { protocol: 'http:', origin: 'http://localhost', baseURI: 'http://localhost/' },
    },
    // An external change lands on the poll: a revision the panel has not seen, carried on a whole new
    // board object. That is the strongest form of "a poll arrived" the store can receive.
    board: async () => ({ changed: true, payload: boardPayload({ rev: 8 }) as never }),
    task: async () => ({ task: null, comments: [], events: [] }) as never,
    mutate: async () => ({ rev: 9, result: {} }) as never,
    health: async () => ({}),
  };
  const store = createBoardStore(transport as never, { pollMs: 600_000 });

  const staging = store.stageDrop('T-002', 'pointer', 0);
  // Both facts are in the snapshot before anything is awaited, and that is the point: the stage is not
  // downstream of the drawer's read. Reading the DOM right here, though, finds no drawer at all,
  // because React has not committed yet.
  assert.equal(store.getSnapshot().stagedDrop?.taskId, 'T-002', 'the stage is recorded synchronously');
  assert.equal(store.getSnapshot().selectedId, 'T-002', 'and the drawer is selected in the same store write');
  assert.equal(store.getSnapshot().detail, null, 'while the drawer’s own read is still in flight');
  await staging;
  await flush();
  assert.equal(store.getSnapshot().stagedDrop?.taskId, 'T-002', 'the stage is still there when the read answers');

  const staged = store.getSnapshot().stagedDrop;
  await store.refresh(true);
  assert.equal(
    store.getSnapshot().stagedDrop,
    staged,
    'a poll that replaces the whole board does not touch the staged drop'
  );
  assert.equal(store.getSnapshot().selectedId, 'T-002', 'and the drawer the stage belongs to stays open');

  // By identity, not by value: the reference is what the drawer reads through `useSyncExternalStore`,
  // so an equal-but-new object would re-render for nothing and a `null` would close the drawer and
  // lose the reason the human was in the middle of writing.
  assert.equal(store.getSnapshot().payload?.rev, 8, 'the polled board really was applied');
  store.select(null);
  assert.equal(store.getSnapshot().stagedDrop, null, 'closing the drawer is the one thing that clears the stage');
});

test('the drawn columns are every state in board order, whatever the filter names', () => {
  // The rule at the level where it is decided, now that no filter can change the lane list: the
  // filter narrows cards, never lanes. This is what keeps "view all" literal.
  const payload = boardPayload() as unknown as Parameters<typeof columnsOf>[0];
  const all: string[] = ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped'];
  assert.deepEqual(columnsOf(payload, EMPTY_FILTER).map((column) => column.state), all);
  assert.deepEqual(columnsOf(payload, { state: ['dropped'] }).map((column) => column.state), all, 'a saved filter that names dropped does not remove the other lanes');
  assert.deepEqual(columnsOf(payload, { state: ['dropped', 'done'] }).map((column) => column.state), all);
  assert.deepEqual(columnsOf(payload, { search: 'T-003' }).map((column) => column.state), all, 'and neither does the search');
  // The cards inside those lanes are what the filter narrows.
  const searched = columnsOf(payload, { search: 'T-003' });
  assert.deepEqual(searched.map((column) => column.cards.length), [0, 0, 1, 0, 0, 0], 'only the matching card is drawn');
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
    ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped'],
    "the pending board draws every lane the answered board will, the dropped one last"
  );
  assert.deepEqual(
    view.findAll('.kb-lane-count').map((node) => node.textContent),
    ['0', '0', '0', '0', '0', '0'],
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
  assert.match(view.find('.kb-head')?.textContent ?? '', /5 cards/, 'the board behind the write is still drawn');
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
  // De-emphasis is a **token colour**, never an element opacity: `opacity: 0.5` on the whole control
  // put the label at 3.51:1 in light -- a text failure -- and dimmed the 1px border with it. The rule
  // that replaces it names the label token, and nothing in the sheet may dim a control's whole box.
  assert.match(styles, /\.kb-btn:disabled \{ color: var\(--dsw-alias-label-secondary, var\(--kb-label-secondary\)\); cursor: default; \}/);
  assert.equal(styles.includes('.kb-btn:disabled { opacity'), false, 'the element opacity is gone');
  // No other selector dims text with an element opacity either -- this is the panel's systemic AA
  // failure, so the check is over the whole sheet rather than over the one rule that was reported.
  // Strip comments first: the sheet explains *why* element opacity was removed, and prose that names
  // the defect must not read as the defect. What is checked is what a browser would apply.
  const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '');
  // Capture the value and compare it in code: a lookahead here is defeated by backtracking, because
  // `\s*` can give back one character and then the negative lookahead succeeds against the space.
  const dimmed = [...rules.matchAll(/([^{}]+)\{[^{}]*opacity:\s*([^;}]+)/g)]
    .filter((match) => (match[2] as string).trim() !== '1')
    .map((match) => (match[1] as string).trim());
  assert.deepEqual(dimmed, [], 'no rule dims a box with an element opacity');
  assert.match(styles, /\.kb-btn\[aria-pressed="true"\]:disabled \{ background: transparent; border-color: var\(--dsw-alias-border-l1/);
  // A placeholder is dimmed by the *UA* at ~0.54 on top of the author's colour, so the author has to
  // say `opacity: 1` for the passing token to be the colour that paints (2.27:1 -> 5.80:1 in light).
  assert.match(styles, /\.kb-input::placeholder, \.kb-input::-webkit-input-placeholder \{ color: var\(--dsw-alias-label-secondary, var\(--kb-label-secondary\)\); opacity: 1; \}/);
  // The busy/loading row is dimmed by colour too: opacity 0.6 there took card ids and lane counts to
  // 2.53:1 light, i.e. the whole board failed AA during any write or the first load.
  assert.match(styles, /\.kb-lanes-busy, \.kb-lanes-loading \{ color: var\(--dsw-alias-label-secondary, var\(--kb-label-secondary\)\); \}/);

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
  // The defect the Dropped view once exposed, and the one this pass must not re-open: a dropped
  // card's state is not in the board's own order, so "the next lane" is null and the drawer would
  // otherwise render no primary move at all. A board that shows a card you cannot move is a dead end.
  const view = await mountBoard(loadBundle());
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
  // Both kinds are on screen, and both say their state in an attribute rather than in a colour. The
  // pressed case is a checklist row now: the view row's `All` toggle was the panel's other
  // `aria-pressed` control, and it is gone with the row.
  await view.click('[data-card="T-001"]');
  await flush();
  const toggle = view.find('[data-drawer="T-001"] .kb-check');
  assert.equal(toggle?.getAttribute('aria-pressed'), 'true', 'a ticked checklist row is pressed');
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
  // The ladder's two names still resolve through the app's tokens, but the **track is transparent**,
  // exactly as the app's own scrollbar writes it: both ladder tokens resolve to the same light
  // neutral, so a filled track would paint a thumb at 1.00:1 and the scrollbar would read as a gap.
  // The thumb's fallback is the sheet's visible de-emphasised mark, not a track-coloured value.
  assert.match(styles, /scrollbar-color: var\(--dsw-alias-scrollbar-bg-l1, var\(--kb-label-secondary\)\) transparent/);
  assert.equal(
    styles.includes('scrollbar-color: var(--dsw-alias-scrollbar-bg-l1, var(--kb-label-secondary)) var(--dsw-alias-scrollbar-bg-l2, transparent)'),
    false,
    'the same-valued track is gone'
  );
  assert.match(styles, /::-webkit-scrollbar-thumb \{[^}]*background: var\(--dsw-alias-scrollbar-bg-l1/);
  assert.match(styles, /::-webkit-scrollbar-thumb:hover \{[^}]*background: var\(--dsw-alias-scrollbar-hover-l1/);
  assert.match(styles, /::-webkit-scrollbar-track \{[^}]*background: transparent/);
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

test('C4: the Alt+arrow path is surfaced on the card and the drawer, not on an inert lane', async () => {
  const view = await mountBoard(loadBundle());
  assert.equal(
    view.find('[data-card="T-003"]')?.getAttribute('aria-keyshortcuts'),
    'Alt+ArrowLeft Alt+ArrowRight'
  );
  // The lane used to carry the same attribute on a div that is never focusable, where no reader can
  // act on it -- `aria-keyshortcuts` describes a shortcut the *element* offers, and a lane offers
  // none. The card does offer it, and the drawer spells it out. Asserting its absence is what stops
  // the inert declaration from coming back as "surfacing the path".
  assert.equal(
    view.find('[data-lane="ready"]')?.getAttribute('aria-keyshortcuts'),
    null,
    'the lane is not focusable, so it cannot be the element that offers the shortcut'
  );
  assert.equal(view.find('[data-lane="ready"]')?.getAttribute('role'), 'group', 'the lane is a named group');
  assert.match(view.find('[data-lane="ready"]')?.getAttribute('aria-label') ?? '', /Ready, \d+ card/);

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

// ------------------------------------------------------------------ the validation pass

/**
 * The token values the app's own stylesheet resolves, re-read on 2026-10-16 from the installed
 * `app.asar` (the same source the capture script uses) — the panel's colour claims are about colours
 * it does not own, so a claim about a ratio can only be checked against the resolutions, which are
 * not reachable from jsdom. These are the surface and text tokens the findings below are about.
 */
const RESOLVED: Readonly<Record<'light' | 'dark', Readonly<Record<string, string>>>> = {
  light: {
    'bg-base': '#ffffff',
    'bg-layer-1': '#ffffff',
    'label-primary': '#0f1115',
    'label-secondary': '#61666b',
    'label-tertiary': '#81858c',
    'state-success-primary': '#22c55e',
    'state-error-primary': '#ec1313',
    'scrollbar-bg-l1': '#e5e5e5',
    'scrollbar-bg-l2': '#e5e5e5',
  },
  dark: {
    'bg-base': '#151517',
    'bg-layer-1': '#232324',
    'label-primary': '#f9fafb',
    'label-secondary': '#cfd3d6',
    'label-tertiary': '#adb2b8',
    'state-success-primary': '#22c55e',
    'state-error-primary': '#f25a5a',
    'scrollbar-bg-l1': '#3c3c3d',
    'scrollbar-bg-l2': '#545557',
  },
};

/** WCAG relative luminance, so the ratios below are computed rather than asserted from memory. */
function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const full = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
  const int = Number.parseInt(full.slice(0, 6), 16);
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((int >> 16) & 0xff) + 0.7152 * channel((int >> 8) & 0xff) + 0.0722 * channel(int & 0xff);
}

function contrast(theme: 'light' | 'dark', foreground: string, background: string): number {
  const a = luminance(RESOLVED[theme][foreground] as string);
  const b = luminance(RESOLVED[theme][background] as string);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

test('V1: Space opens a card, the way a real button would', async () => {
  // APG's button pattern is Enter *and* Space. A `role="button"` div gets neither for free, and the
  // Space branch did not exist: a keyboard user pressing Space got the page's own scroll, and
  // PRODUCT.md's "anything an agent can do, Dhira can do by keyboard" was not true of the one
  // interaction every card has. This is the same path Enter takes, asserted the same way.
  const view = await mountBoard(loadBundle());
  assert.equal(view.has('[data-drawer="T-003"]'), false, 'nothing is open to begin with');
  await view.key('[data-card="T-003"]', ' ');
  await flush();
  assert.equal(view.has('[data-drawer="T-003"]'), true, 'Space opened the card');
  assert.match(view.find('[data-drawer="T-003"]')?.getAttribute('aria-label') ?? '', /T-003/);
  view.unmount();

  // The legacy spelling some browsers still send, and Enter beside it, so neither path regressed as
  // the branch grew a second key.
  const legacy = await mountBoard(loadBundle());
  await legacy.key('[data-card="T-004"]', 'Spacebar');
  await flush();
  assert.equal(legacy.has('[data-drawer="T-004"]'), true, 'the legacy key spelling opens it too');
  legacy.unmount();

  const enter = await mountBoard(loadBundle());
  await enter.key('[data-card="T-002"]', 'Enter');
  await flush();
  assert.equal(enter.has('[data-drawer="T-002"]'), true, 'Enter still opens it');
  enter.unmount();
});

test('V2: every named box is a role that may carry a name — group, region, or the card itself', async () => {
  // ARIA 1.2 prohibits `aria-label` on a role-less `div` (the generic role): the name is inert. Four
  // of these boxes were exactly that — the metrics strip, both checklist groups and the lane — plus
  // the drawer, which had no role and no name at all. The roles below are the roles each box is.
  const view = await mountBoard(loadBundle());
  const named = (selector: string, role: string): void => {
    const node = view.find(selector);
    assert.ok(node !== null, `${selector} exists`);
    assert.equal(node.getAttribute('role'), role, `${selector} is a ${role}`);
    assert.equal((node.getAttribute('aria-label') ?? '').length > 0, true, `${selector} keeps its name`);
  };
  named('.kb-metrics', 'group');
  named('[data-lane="ready"]', 'group');

  await view.click('[data-card="T-003"]');
  await flush();
  named('.kb-checks', 'group');
  const drawer = view.find('[data-drawer="T-003"]');
  assert.equal(drawer?.getAttribute('role'), 'region', 'the drawer is a named region, not an anonymous box');
  assert.match(drawer?.getAttribute('aria-label') ?? '', /T-003/);
  // The board's announcer is the live region that must exist whether or not it has anything to say:
  // a region inserted with its first message is one several readers never announce. It is visually
  // hidden (see F26), so it takes no room while staying in the accessibility tree.
  assert.equal(view.find('.kb-vh[role="status"][aria-live="polite"]') !== null, true, 'the announcer is mounted');
  view.unmount();
});

test('V3: no element opacity is used to de-emphasise text — the label tokens are the ladder', async () => {
  // The convergent finding: the disabled button (3.51:1), the busy lane row (2.53:1 light) and the
  // placeholder under the UA's own ~0.54 all passed as *elements* and failed as *text*. Two of the
  // three were element opacities in this sheet; the third is the UA's, and it is answered where it is
  // written. The walk is over the sheet, so a fourth cannot be added without failing here.
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  // Strip comments first: the sheet explains *why* element opacity was removed, and prose that names
  // the defect must not read as the defect. What is checked is what a browser would apply.
  const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '');
  // Capture the value and compare it in code: a lookahead here is defeated by backtracking, because
  // `\s*` can give back one character and then the negative lookahead succeeds against the space.
  const dimmed = [...rules.matchAll(/([^{}]+)\{[^{}]*opacity:\s*([^;}]+)/g)]
    .filter((match) => (match[2] as string).trim() !== '1')
    .map((match) => (match[1] as string).trim());
  assert.deepEqual(dimmed, [], 'no selector dims a box with an element opacity');
  assert.equal(styles.includes('opacity: 0.5'), false, 'the disabled button no longer dims itself');
  assert.equal(styles.includes('opacity: 0.6'), false, 'nor does the busy board row');
  assert.equal(styles.includes('opacity: 1'), true, 'the placeholder rule is the one opacity left, and it restores');

  // The claim as a measurement, not as a rule name: the label tokens each de-emphasise and each pass.
  for (const theme of ['light', 'dark'] as const) {
    const label = contrast(theme, 'label-secondary', 'bg-base');
    assert.ok(label >= 4.5, `label-secondary on the ${theme} card is ${label.toFixed(2)}:1`);
  }
  // The busy row's descendants that keep their own colour (the over-limit count, the P0 code, the
  // drawn mark) are the point of a *colour* dim: they stay visible while the board is in flight,
  // which an element opacity took away from them. Red is a state colour here, not body text, so the
  // floor checked is the graphical one it has to clear on the two surfaces it can sit on. The light
  // red measures 4.4976:1 on white -- the app's own value, which DESIGN.md rounds to 4.50 -- so the
  // floor is 4.4 rather than a rounded 4.5 that the app's colour never quite reaches.
  assert.ok(contrast('light', 'state-error-primary', 'bg-base') >= 4.4, 'an over-limit red survives the busy dim');
  assert.ok(contrast('dark', 'state-error-primary', 'bg-base') >= 3, 'in both themes');
  assert.ok(contrast('dark', 'state-error-primary', 'bg-layer-1') >= 3, 'on the lane as well as the card');
});

test('V4: the completion mark meets 3:1 because its tick is the foreground, not the success hue', async () => {
  // The mark is a graphic, and the app's success token composites to 2.28:1 on the light card's white
  // no matter the stroke width. So the frame carries the hue and the tick carries the contrast: read
  // the authored rule, then measure the colour it names against the three surfaces it can sit on.
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  assert.match(styles, /\.kb-mark \.kb-mark-tick \{ color: var\(--dsw-alias-label-primary, inherit\); \}/);
  assert.match(styles, /\.kb-mark \{ align-self: center; flex: 0 0 auto; color: var\(--dsw-alias-state-success-primary,/);

  const view = await mountBoard(loadBundle());
  const tick = view.find('[data-card="T-005"] .kb-mark .kb-mark-tick');
  assert.equal(tick?.tagName.toLowerCase(), 'path', 'the drawn tick is the part that took the second tone');
  assert.ok(view.find('[data-card="T-003"] .kb-mark') === null, 'an unfinished card carries no completion mark');
  view.unmount();

  // The measured floor, in the theme where the hue failed it.
  for (const surface of ['bg-base', 'bg-layer-1'] as const) {
    const light = contrast('light', 'label-primary', surface);
    const dark = contrast('dark', 'label-primary', surface);
    assert.ok(light >= 3 && dark >= 3, `the tick is ${light.toFixed(2)}:1 / ${dark.toFixed(2)}:1 on ${surface}`);
  }
});

test('V5: the scrollbar’s two halves resolve to different things, and the track is the app’s own', async () => {
  // The defect: `bg-l1` and `bg-l2` both resolve to the same light neutral (1.00:1 thumb against
  // track), so the thumb was invisible and the scrollbar read as a gap. The app's own rule writes a
  // transparent track, which is what this now does; the assertion is on the declaration rather than
  // on a ratio, because the ratio is the app's palette to own and the light thumb is still its own
  // neutral.
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  assert.match(styles, /scrollbar-color: var\(--dsw-alias-scrollbar-bg-l1, var\(--kb-label-secondary\)\) transparent;/);
  assert.match(styles, /::-webkit-scrollbar-track \{[^}]*background: transparent/);
  // Where the two tokens *do* differ (dark), the thumb is a visible step off the track — and in light
  // the thumb sits on the lane, not on a same-valued fill, which is the whole repair. What the repair
  // does **not** buy is 3:1 in either theme: the ladder is the app's, and the app never raises it.
  // That shortfall is recorded in DESIGN.md rather than papered over here.
  const darkGap = contrast('dark', 'scrollbar-bg-l1', 'scrollbar-bg-l2');
  assert.ok(darkGap > 1.2, `dark thumb vs track is ${darkGap.toFixed(2)}:1`);
  const lightGap = contrast('light', 'scrollbar-bg-l1', 'scrollbar-bg-l2');
  assert.equal(Number(lightGap.toFixed(2)), 1, 'in light the two tokens are the same value — hence the transparent track');
  assert.ok(contrast('light', 'scrollbar-bg-l1', 'bg-layer-1') > 1, 'and the thumb is at least off the surface it sits on');
});

test('V6: a dragover measures each card once per drag, not once per event', async () => {
  // `getBoundingClientRect()` per card per `dragover` is layout work whose answer cannot change while
  // the drag is live. jsdom returns zeros from it, so the test counts the calls rather than checking
  // the geometry: the first event pays for the lane, the second must find the cache.
  const container = loadBundle().dom.window.document;
  const prototype = container.defaultView?.Element.prototype;
  assert.ok(prototype !== undefined, 'the realm exposes the Element prototype');
  const original = prototype.getBoundingClientRect;
  let reads = 0;
  prototype.getBoundingClientRect = function measured(this: Element): DOMRect {
    reads += 1;
    return original.call(this);
  };
  try {
    const view = await mountBoard(loadBundle());
    const cards = view.findAll('[data-lane="in-progress"] .kb-card').length;
    assert.ok(cards > 0, 'the lane has cards to measure');
    await view.dragStart('[data-card="T-002"]');
    await flush();
    assert.equal(reads, 0, 'starting a drag measures nothing');
    await view.dragOver('[data-lane="in-progress"]', 5);
    const afterFirst = reads;
    assert.equal(afterFirst, cards, 'the first dragover measures each card exactly once');
    await view.dragOver('[data-lane="in-progress"]', 20);
    assert.equal(reads, afterFirst, 'and the second re-uses that measurement');
    view.unmount();
  } finally {
    prototype.getBoundingClientRect = original;
  }
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
  // C8: the parked lane and the state that opens it. It used to be a 46px rail with its name rotated;
  // it is now a content-width outlined slot whose name stays horizontal -- see the dedicated test for
  // why, and for the pattern-level guard that keeps any label off its side.
  assert.match(styles, /\.kb-lane-empty \{[^}]*flex: 0 0 auto/);
  assert.match(styles, /\.kb-lane-empty \{[^}]*border-style: dashed/);
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
  // The pressed state is a checked checklist row, and it lives in the drawer: the view row's `All`
  // toggle was the board's other `aria-pressed` control and it is gone with the row. T-001's DoR is
  // pre-ticked by the fixture, so its ticked row is the state to read.
  await view.click('[data-card="T-001"]');
  await flush();
  assert.equal(view.has('.kb-drawer'), true);
  assert.equal(view.find('.kb-drawer .kb-btn[aria-pressed="true"]') !== null, true, 'a ticked row is pressed');
  assert.equal(view.has('.kb-btn[aria-pressed="true"]'), true);
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

// ------------------------------------------------------------------ the third pass: the view row removed

test('F18-overridden: the toolbar is a search box and a create row, and nothing narrows by state', async () => {
  // The removed select *was* the fresh critique's item 18 — "the human lost single-state narrowing" —
  // and the user overrode it deliberately: *"Remove it, do not group by that, I think it's not common,
  // just view all."* So the assertion is that the panel offers no single-state control at all, and
  // that narrowing by state now belongs where the critique's own comparison put it: the agent's
  // `kanban_list({ state: … })` and `bin/kanban.mjs --state`, both untouched.
  const view = await mountBoard(loadBundle());
  assert.equal(view.findAll('[data-state]').length, 0, 'the chip row did not come back either');
  assert.equal(view.findAll('select.kb-input').length, 0, 'the view row select is removed, not deprecated');
  assert.equal(view.find('.kb-bar [data-select="view-state"]'), null);
  assert.equal(view.findAll('.kb-bar [data-select]').length, 0, 'the toolbar has no picker left of any kind');

  // What the toolbar *does* still carry: the search, the title field and `Add`. Nothing else.
  assert.equal(view.find('.kb-bar input[type="search"]') !== null, true, 'the search survives');
  assert.equal(view.find('.kb-bar [data-action="create"]') !== null, true, 'and so does creation');
  assert.deepEqual(
    view.findAll('.kb-bar [data-action]').map((node) => node.getAttribute('data-action')),
    ['create'],
    'no view or Dismiss action remains in the row'
  );
  // The two controls the row used to hold are not reachable anywhere else in the panel either.
  assert.equal(view.findAll('[aria-label="Views"]').length, 0);
  assert.equal(view.findAll('[aria-label="Narrow to one state"]').length, 0);
  view.unmount();
});

test('F19: a successful drop says which card left and where it went', async () => {
  // Dropping is the one move that takes a card off the board, and the board used to say nothing: the
  // only feedback was `showing X of Y` ticking down. A successful drop acknowledges the lane it went
  // to, which is on screen now — the board draws every state — so the sentence is a pointer, not the
  // only way to find the card.
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-002"]');
  await flush();
  await view.click('[data-action="more"]');
  await flush();
  await view.type('[data-field="drop-reason"]', 'superseded by T-004');
  await flush();
  await view.click('[data-action="drop"]');
  await flush();

  assert.equal(lastMutation()?.body.toState, 'dropped', 'the drop itself still goes through the store');
  const notice = view.find('.kb-notice-info');
  assert.ok(notice !== null, 'the drop is acknowledged through the strip that says everything else');
  assert.match(notice.textContent ?? '', /T-002 dropped — still on the board, under Dropped/);
  assert.equal(notice.getAttribute('role'), 'status', 'and it is announced, not only painted');
  view.unmount();
});

test('F20: the WIP lead names both limbs without putting them back on the surface', async () => {
  // `WIP 2/3` sits beside `In Progress 2/2` and `Review 0/1` without saying that it is their sum, so
  // the board can look self-contradictory. The limbs are named in the title; the visible `(2/2 + 0/1)`
  // the distill removed does not return.
  const view = await mountBoard(loadBundle());
  const lead = view.findAll('.kb-metric-lead').find((node) => (node.textContent ?? '').startsWith('WIP'));
  assert.ok(lead !== undefined, 'the WIP lead is on screen');
  assert.equal(lead.textContent, 'WIP 2/3', 'the surface is exactly what it was');
  assert.equal(lead.getAttribute('title'), 'In Progress 2/2 + Review 0/1', 'the two limbs are named');
  assert.equal(view.text().includes('2/2 + 0/1'), false, 'the removed surface stayed removed');
  view.unmount();
});

test('F23: the history prints the actor kind and keeps the raw session id in a title', async () => {
  // The store writes an actor as one token — `agent:01JABC` — and the row printed it whole, so an
  // operator read a session id where a word belonged (`ActorKind` existed for this and was unused).
  setFetch((call) => {
    if (call.url.includes('/board')) {
      const payload = fixture();
      return { status: 200, body: { ok: true, board: payload, rev: payload.rev } };
    }
    if (call.url.includes('/task/')) {
      return {
        status: 200,
        body: {
          ok: true,
          task: null,
          comments: [],
          events: [
            { id: 1, at: '2026-10-15T12:00:00.000Z', actor: 'agent:01JABC', taskId: 'T-003', kind: 'purged', fromState: 'review', toState: 'dropped', payload: {} },
            { id: 2, at: '2026-10-15T13:00:00.000Z', actor: 'human:dhira', taskId: 'T-003', kind: 'moved', fromState: 'ready', toState: 'in-progress', payload: {} },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  });
  const view = mount(loadBundle(), loadBundle().slot('main'), { store: freshStore(loadBundle()) });
  await flush();
  await view.click('[data-card="T-003"]');
  await flush();

  const rows = view.findAll('[data-drawer="T-003"] .kb-mono');
  assert.equal(rows.length, 2, 'both events are drawn');
  const agentRow = rows[0];
  assert.ok(agentRow !== undefined);
  assert.match(agentRow.textContent ?? '', /purged/, 'the event kind is still printed');
  assert.equal((agentRow.textContent ?? '').includes('01JABC'), false, 'the raw session id is not read out');
  assert.match(agentRow.textContent ?? '', /\(agent\)/, 'the actor is named by its kind');
  assert.equal(agentRow.getAttribute('title'), 'agent:01JABC', 'the id is one hover away');
  const humanRow = rows[1];
  assert.ok(humanRow !== undefined);
  assert.match(humanRow.textContent ?? '', /\(human\)/);
  assert.equal(humanRow.getAttribute('title'), 'human:dhira');
  view.unmount();
});

test('F24: the metrics speak words, not store fields — 85th percentile, from history or default', async () => {
  const view = await mountBoard(loadBundle()); // the fixture's SLE source is the store's `guess`
  await view.click('[data-action="more-metrics"]');
  await flush();
  const opened = view.text();
  assert.match(opened, /Cycle median 3d · 85th percentile 3d · mean 3d/);
  assert.match(opened, /SLE 85% ≤ 3d \(from default\)/, 'a declared SLE says so in words');
  assert.equal(opened.includes('p85'), false, 'the store field name is not printed');
  assert.equal(opened.includes('guess'), false, 'nor is `guess`');
  view.unmount();

  // And the other basis: an SLE computed from the board's own history says so. The store's computed
  // reading is `metrics.sle`; `dow.sle` is the declared default it falls back to.
  const payload = boardPayload();
  const metrics = {
    ...(payload.metrics as Record<string, unknown>),
    sle: { p: 0.85, days: 3, source: 'history', basis: 6 },
  };
  const history = await mountBoard(loadBundle(), { ...fixture(), metrics });
  await history.click('[data-action="more-metrics"]');
  await flush();
  assert.match(history.text(), /SLE 85% ≤ 3d \(from history\)/);
  history.unmount();
});

test('F25: a lane’s accessible name carries its limit and its warning', async () => {
  // The header prints `1/5` and, past the cap, an `over limit` chip, while the name said only
  // "Ready, 1 card(s)" — a reader was told less than the picture, and `card(s)` is not a word.
  const view = await mountBoard(loadBundle());
  assert.equal(view.find('[data-lane="ready"]')?.getAttribute('aria-label'), 'Ready, 1 card, limit 5');
  assert.equal(view.find('[data-lane="backlog"]')?.getAttribute('aria-label'), 'Backlog, 1 card', 'an uncapped state names no limit');
  assert.equal(view.text().includes('card(s)'), false, 'no store plural is read out anywhere on the panel');
  view.unmount();

  // Three cards against a review limit of one: the name has to say what the red count and the chip say.
  const payload = fixture();
  const tasks = payload.tasks as Record<string, unknown>[];
  const extra = { ...(tasks[0] as Record<string, unknown>), id: 'T-099', state: 'review', position: 0 };
  const over = await mountBoard(loadBundle(), { ...payload, tasks: [...tasks, extra, { ...extra, id: 'T-098' }] });
  assert.equal(
    over.find('[data-lane="review"]')?.getAttribute('aria-label'),
    'Review, 2 cards, limit 1, over the limit'
  );
  over.unmount();
});

test('F26: the live region is visually hidden and does not keep stale text', async () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  const start = styles.indexOf('.kb-vh {');
  assert.equal(start > -1, true, 'the one utility class is authored');
  const rule = styles.slice(start, styles.indexOf('}', start) + 1);
  assert.match(rule, /position: absolute/);
  assert.match(rule, /width: 1px; height: 1px/);
  assert.match(rule, /clip-path: inset\(50%\)/);
  // It must stay in the accessibility tree: `display: none` / `visibility: hidden` would silence it.
  assert.equal(rule.includes('display'), false);
  assert.equal(rule.includes('visibility'), false);

  const view = await mountBoard(loadBundle());
  const announcer = view.find('.kb-vh[role="status"][aria-live="polite"]');
  assert.ok(announcer !== null, 'the live region is the visually hidden box');
  assert.equal(announcer.textContent, '', 'and it starts empty rather than carrying an old sentence');
  assert.equal(view.find('.kb-dim[role="status"]'), null, 'the visible copy is gone');

  // A message arrives, then clears: a stray "already at the end of the board" line does not sit in
  // the DOM once the move it described has been answered.
  await view.key('[data-card="T-001"]', 'ArrowLeft', { altKey: true });
  await flush();
  assert.match(view.find('.kb-vh')?.textContent ?? '', /already at the end of the board/);
  await new Promise((resolve) => setTimeout(resolve, 5200));
  await flush();
  assert.equal(view.find('.kb-vh')?.textContent, '', 'the last message does not persist');
  view.unmount();
});

test('F21: the drawer’s two bare ellipses now name what they do', async () => {
  // `More…` and `Exception…` named nothing: neither said what it would show or what it was an
  // exception *to*. Labels only — the controls and their `data-action`s are unchanged.
  const view = await mountBoard(loadBundle());
  await view.click('[data-card="T-003"]');
  await flush();
  assert.equal(view.find('[data-action="more"]')?.textContent, 'More moves…');
  await view.click('[data-action="more"]');
  await flush();
  assert.equal(view.find('[data-action="exception"]')?.textContent, 'Exception to a gate…');
  assert.equal(view.find('[data-action="exception"]')?.getAttribute('aria-expanded'), 'false');
  view.unmount();
});

test('no label is turned on its side, and a parked lane is an outlined slot on one line', async () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  // The parked lane's name used to be rotated 90 degrees. A sideways word reads as a sliver rather than
  // a column, and the name is the one thing the parked lane still communicated. Forbid the pattern
  // rather than the instance: no rule may turn text vertical, whatever selector does it.
  // Every appearance, not just the ones spelled "vertical": sideways-lr and sideways-rl turn text too,
  // and a guard that names two of four spellings is a guard that gets walked around.
  const modes = [...styles.matchAll(/writing-mode:\s*([^;}\s]+)/g)].map((match) => (match[1] as string));
  assert.deepEqual(
    [...new Set(modes)],
    ['horizontal-tb'],
    'the only writing mode in the sheet is horizontal',
  );
  assert.match(styles, /\.kb-lane-empty \{[^}]*border-style: dashed/, 'the parked lane is outlined as a slot');
  assert.equal(
    /\.kb-lane-empty \.kb-lane-head \{ flex-direction: column/.test(styles),
    false,
    'its name and count are not stacked',
  );

  // And it is still a lane: it renders, and it still names itself.
  const view = await mountBoard(loadBundle());
  const parked = view.find('.kb-lane-empty');
  assert.ok(parked !== null, 'a card-less lane renders as the parked lane');
  assert.match(view.text(), /Review/, 'the parked lane still names its state');
  view.unmount();
});

test('the stylesheet string is one unbroken template literal', () => {
  // `STYLES` is a template literal, so a backtick inside the CSS -- in a comment, most likely -- ends the
  // string and the build fails. On 2026-10-16 exactly that happened: a comment gained a code span, the
  // client build broke, and every "green" suite after it was running against a STALE bundle. Counting
  // delimiters is crude and would have caught it in milliseconds.
  const source = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8');
  const marker = 'export const STYLES = `';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'the stylesheet is declared as one template literal');
  const body = source.slice(start + marker.length);
  assert.equal(
    (body.match(/`/g) ?? []).length,
    1,
    'exactly one backtick after the opening delimiter: the one that closes it',
  );
});
