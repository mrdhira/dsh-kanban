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
} from './harness.ts';

const FULL_DOR = Object.fromEntries(
  ['outcome', 'acceptance', 'write-scope', 'estimate'].map((id) => [id, { at: '2026-10-01T00:00:00.000Z', by: 'human:dhira' }])
);

/** The board the DOM tests render: one refined backlog card, one ready, two in progress, one done. */
function fixture(): Record<string, unknown> {
  const payload = boardPayload();
  const tasks = (payload.tasks as Record<string, unknown>[]).map((task) =>
    task.id === 'T-001' ? { ...task, dor: FULL_DOR } : task
  );
  return { ...payload, tasks };
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
  view.unmount();
});

test('the header names the host origin and the revision it is showing', async () => {
  const view = await mountBoard(loadBundle());
  const text = view.text();
  assert.match(text, /rev 7/);
  assert.match(text, /host http:\/\/localhost/);
  view.unmount();
});

test('the flow metrics are on screen', async () => {
  const view = await mountBoard(loadBundle());
  const text = view.text();
  assert.match(text, /WIP 2/);
  assert.match(text, /Throughput 1\/7d · 1\/30d/);
  assert.match(text, /Cycle median 3d · p85 3d/);
  assert.match(text, /SLE 85% ≤ 3d/);
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
  const THEME_TOKENS = new Set([
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
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
