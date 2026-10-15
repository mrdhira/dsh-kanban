/**
 * Client half of the dsh-kanban bundle (TypeScript source).
 *
 * A DSH client module is a plain script registering a lazy factory whose `id` equals the package
 * name; the factory returns a Cordis plugin. `build.mjs` wraps this module in that handshake, so
 * this file is an ordinary CommonJS module: React and the local modules arrive through `require`,
 * and the factory's return value is `module.exports`.
 *
 * ## Why `require` and not `import` here
 *
 * Every other file in this half uses ESM syntax. This one — the entry — uses `require(...)` with
 * `as typeof import('./x.js')` for types, which keeps a single module system in a file that must also
 * read `require('react')`: the app's loader hands the factory a `require` and expects
 * `module.exports` back, and mixing both syntaxes in one file is the kind of thing that works until
 * the bundler's interop decides it does not.
 *
 * ## What it registers
 *
 * Two slot entries and nothing else: the sidebar icon, and the panel body keyed by the same id. The
 * panel is the board; everything it knows comes from the store, which is built here once and
 * handed to the component as a prop.
 */
const React = require('react') as unknown as import('./components').ReactLike;

const { createBoardStore } = require('./store.js') as typeof import('./store.js');
const { createHttpTransport, resolveOrigin } = require('./api.js') as typeof import('./api.js');
const { BoardPage, createKanbanIcon } = require('./components.js') as typeof import('./components.js');

const PLUGIN_ID = 'dsh-kanban';
const PANEL_ID = 'kanban';
/** Beside Plugins (0) and before Skills (5), where a board belongs. */
const PANEL_ORDER = 4;
const POLL_MS = 5000;

/** The page's own globals, read defensively: this module must load even in a bare realm. */
const page = globalThis as unknown as {
  fetch?: unknown;
  document?: { visibilityState?: string };
  location?: { protocol?: string; origin?: string; href?: string };
  __DSH_TRANSPORT__?: { streamBaseUrl?: unknown };
};

/**
 * A transport that reports why it cannot work, rather than throwing at load.
 *
 * If `fetch` is missing the panel must still render and say so — a blank page would be
 * indistinguishable from an empty board, which is the diagnostic failure this whole half exists to
 * avoid.
 */
const fetchImpl =
  typeof page.fetch === 'function'
    ? (page.fetch as (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
        ok: boolean;
        status: number;
        text(): Promise<string>;
      }>)
    : async (): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
        throw new Error('this page exposes no fetch, so the board cannot reach its host route');
      };

const origin = resolveOrigin({
  ...(page.__DSH_TRANSPORT__ === undefined ? {} : { transport: page.__DSH_TRANSPORT__ }),
  ...(page.location === undefined ? {} : { location: page.location }),
});

/**
 * A fresh store over the same transport.
 *
 * Exporting the factory as well as the instance is what lets the DOM suite mount an isolated panel
 * per test: the bundle is evaluated once per realm, so without this every test would share one
 * store and inherit the previous test's board, filter and selection.
 */
function createStore(): ReturnType<typeof createBoardStore> {
  return createBoardStore(createHttpTransport(fetchImpl, origin), {
    pollMs: POLL_MS,
    visible: () => page.document?.visibilityState !== 'hidden',
  });
}

const store = createStore();

function apply(ctx: { slots?: { inject?(name: string, run: () => unknown): unknown; register?(spec: Record<string, unknown>, component: unknown): unknown } }): void {
  const slots = ctx.slots;
  if (slots === undefined) return;

  slots.inject?.('main', () =>
    slots.register?.(
      { name: 'main', key: PANEL_ID, inject: () => ({ React, store, documentRef: page.document }) },
      BoardPage
    )
  );

  slots.inject?.('sidebar.panellist', () =>
    slots.register?.(
      { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => 'Kanban' },
      createKanbanIcon(React)
    )
  );
}

module.exports = { name: PLUGIN_ID, inject: ['slots'], apply, store, createStore };
